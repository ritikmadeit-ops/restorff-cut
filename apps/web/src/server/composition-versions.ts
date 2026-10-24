/**
 * Composition versions and the timeline kit (composition-v3 agent, 2026-10-21; neon-grid-nitro REPORT items 3, 4, 9).
 *
 *   versions     every render of a composition clip (write, update, revise, revert, a kit change) appends a version to
 *                `element.restorff.composition.versions[]`: {v, at, note, kind, source_sha?, props_sha, kit_sha?, hash,
 *                duration}. The texts themselves (source HTML, props JSON, kit) live ONCE each in a content-addressed
 *                store (table rc_composition_store, sha256 → body), so a snapshot only carries hashes. A clip made before
 *                versions were kept gets its current state as v1 the first time it changes.
 *   history      versions with what changed between each and the one before (props a → b, source +/− lines, kit, length)
 *   revert       the change that puts a version back (its source, its props exactly, its length) — one commit through
 *                commitAsClaude, recorded as a NEW version ("revert to v2"): history stays append-only
 *   timeline kit `metadata.restorff.kit = {sha, bytes, at, by, from, history[]}`; the body in the store. A custom source
 *                with `<!-- rc-kit -->` renders with it (packages/compositions CONTRACT §9c); a kit change re-renders
 *                exactly those clips in one commit (mcp/composition.ts `kit`).
 *
 * Pure helpers take a BlobStore so tests run on a Map; `dbStore()` is the real one (created on first use, like
 * storyboard-versions.ts: CREATE TABLE IF NOT EXISTS once per process).
 */
import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { getDb, type StoreDb } from "@/lib/db/store";
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";

export const KIT_MARKER = "<!-- rc-kit -->";
/** Versions kept per clip (the oldest beyond this are dropped from the clip; their blobs stay in the store). */
export const MAX_VERSIONS = 100;

export type BlobKind = "source" | "props" | "kit";
export type KitInput = string | { css?: string; js?: string; html?: string };

export interface CompositionVersion {
	v: number;
	at: string;
	/** Why it was made: "write", "update", "revert to v2", "kit changed", the commit message… */
	note: string;
	kind: "custom" | "library";
	name?: string;
	title?: string;
	/** custom only: the source HTML in the store */
	source_sha?: string;
	/** the props (stable JSON) in the store */
	props_sha: string;
	/** the timeline kit it rendered with (store sha), when its source includes the kit */
	kit_sha?: string;
	/** the render's hash (same input → same file) */
	hash?: string;
	duration?: number;
}

/** The composition record on a clip (element.restorff.composition), with the fields this module adds. */
export interface VersionedComposition {
	custom?: boolean;
	name?: string;
	title?: string;
	source?: string;
	props?: Record<string, unknown>;
	hash?: string;
	width?: number;
	height?: number;
	fps?: number;
	duration?: number;
	author?: string;
	kit_sha?: string;
	versions?: CompositionVersion[];
}

export interface TimelineKitRecord {
	sha: string;
	bytes: number;
	at: string;
	by?: string;
	/** "inline" (sent as code) or "library:<name>" (packages/compositions/kits/<name>.js) */
	from: string;
	history?: Array<{ sha: string; at: string; from: string }>;
}

export interface BlobStore {
	put(items: Array<{ kind: BlobKind; body: string }>): Promise<string[]>;
	get(shas: string[]): Promise<Map<string, string>>;
}

// ─── hashing ────────────────────────────────────────────────────────────────────────────────────────────────────

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** JSON with object keys sorted at every level: the same props in any key order hash the same. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.filter((k) => o[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** The kit as the store keeps it: canonical JSON of {css?, html?, js?} (a string kit is HTML). */
export function kitBody(kit: KitInput): string {
	const obj = typeof kit === "string" ? { html: kit } : { ...(kit.css ? { css: kit.css } : {}), ...(kit.html ? { html: kit.html } : {}), ...(kit.js ? { js: kit.js } : {}) };
	return stableJson(obj);
}

export function kitFromBody(body: string): KitInput {
	const parsed = JSON.parse(body) as { css?: string; js?: string; html?: string };
	return parsed;
}

// ─── versions (pure) ────────────────────────────────────────────────────────────────────────────────────────────

/** What a record is right now, as a version entry (+ the blobs it needs in the store). */
export function versionEntry(record: VersionedComposition, v: number, note: string, at: string): { entry: CompositionVersion; blobs: Array<{ kind: BlobKind; body: string }> } {
	const custom = record.custom === true;
	const props = stableJson(record.props ?? {});
	const blobs: Array<{ kind: BlobKind; body: string }> = [{ kind: "props", body: props }];
	if (custom && typeof record.source === "string") blobs.push({ kind: "source", body: record.source });
	const entry: CompositionVersion = {
		v,
		at,
		note: note.slice(0, 160),
		kind: custom ? "custom" : "library",
		...(record.name ? { name: record.name } : {}),
		...(record.title ? { title: record.title } : {}),
		...(custom && typeof record.source === "string" ? { source_sha: sha256(record.source) } : {}),
		props_sha: sha256(props),
		...(record.kit_sha ? { kit_sha: record.kit_sha } : {}),
		...(record.hash ? { hash: record.hash } : {}),
		...(typeof record.duration === "number" ? { duration: record.duration } : {}),
	};
	return { entry, blobs };
}

/** The versions a record already has; a record from before versions were kept counts as its own v1. */
export function versionsOf(record: VersionedComposition | null | undefined, at = "unknown"): CompositionVersion[] {
	if (!record) return [];
	if (Array.isArray(record.versions) && record.versions.length) return record.versions;
	if (!record.hash && !record.source && !record.name) return [];
	return [versionEntry(record, 1, "before versions were kept", at).entry];
}

/**
 * `next` with its version history: the previous record's versions (its own state as v1 when it had none) + `next`
 * as the next version. Pure; the blobs both need come back for the store.
 */
export function appendVersion(
	previous: VersionedComposition | null | undefined,
	next: VersionedComposition,
	opts: { note?: string; at?: string } = {},
): { record: VersionedComposition; blobs: Array<{ kind: BlobKind; body: string }> } {
	const at = opts.at ?? new Date().toISOString();
	const prior = versionsOf(previous, at);
	const blobs: Array<{ kind: BlobKind; body: string }> = [];
	if (previous && !(Array.isArray(previous.versions) && previous.versions.length) && prior.length) blobs.push(...versionEntry(previous, 1, "", at).blobs);
	const last = prior[prior.length - 1];
	const made = versionEntry(next, (last?.v ?? 0) + 1, opts.note ?? (prior.length ? "update" : "write"), at);
	blobs.push(...made.blobs);
	const { versions: _old, ...rest } = next;
	const versions = [...prior, made.entry].slice(-MAX_VERSIONS);
	return { record: { ...rest, versions }, blobs };
}

export interface VersionDiff {
	props?: Record<string, string>;
	source?: { added: number; removed: number } | "changed (text not in the store)";
	kind?: string;
	kit?: string;
	duration?: string;
}

const short = (value: unknown) => {
	if (value === undefined) return "—";
	if (typeof value === "string" && value.startsWith("data:")) return "(an image)";
	const text = typeof value === "string" ? JSON.stringify(value) : stableJson(value);
	return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/** Line counts added / removed between two texts (a multiset diff: moved lines count as unchanged). */
export function lineDiff(before: string, after: string): { added: number; removed: number } {
	const count = (text: string) => {
		const map = new Map<string, number>();
		for (const line of text.split("\n")) map.set(line.trim(), (map.get(line.trim()) ?? 0) + 1);
		return map;
	};
	const a = count(before);
	const b = count(after);
	let added = 0;
	let removed = 0;
	for (const [line, k] of b) added += Math.max(0, k - (a.get(line) ?? 0));
	for (const [line, k] of a) removed += Math.max(0, k - (b.get(line) ?? 0));
	return { added, removed };
}

/** What changed from version `a` to version `b` (texts from the store; a missing text says so). */
export function diffVersions(a: CompositionVersion | null, b: CompositionVersion, texts: Map<string, string>): VersionDiff {
	const out: VersionDiff = {};
	if (!a) return out;
	if (a.kind !== b.kind) out.kind = `${a.kind} → ${b.kind}`;
	if (a.props_sha !== b.props_sha) {
		const pa = texts.has(a.props_sha) ? (JSON.parse(texts.get(a.props_sha) as string) as Record<string, unknown>) : null;
		const pb = texts.has(b.props_sha) ? (JSON.parse(texts.get(b.props_sha) as string) as Record<string, unknown>) : null;
		const changed: Record<string, string> = {};
		if (pa && pb) {
			for (const key of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
				if (stableJson(pa[key]) !== stableJson(pb[key])) changed[key] = `${short(pa[key])} → ${short(pb[key])}`;
			}
		} else changed["(props)"] = "changed (text not in the store)";
		out.props = changed;
	}
	if ((a.source_sha ?? "") !== (b.source_sha ?? "") && b.source_sha) {
		const sa = a.source_sha ? texts.get(a.source_sha) : "";
		const sb = texts.get(b.source_sha);
		out.source = sa !== undefined && sb !== undefined ? lineDiff(sa, sb) : "changed (text not in the store)";
	}
	if ((a.kit_sha ?? "") !== (b.kit_sha ?? "")) out.kit = `${a.kit_sha ? a.kit_sha.slice(0, 8) : "none"} → ${b.kit_sha ? b.kit_sha.slice(0, 8) : "none"}`;
	if (a.duration !== b.duration && a.duration !== undefined && b.duration !== undefined) out.duration = `${a.duration} s → ${b.duration} s`;
	return out;
}

/** Props patch that turns `current` into exactly `target` (null removes a key): what revert sends as merged props. */
export function propsPatch(current: Record<string, unknown> | undefined, target: Record<string, unknown>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const key of Object.keys(current ?? {})) if (!(key in target)) patch[key] = null;
	for (const [key, value] of Object.entries(target)) patch[key] = value;
	return patch;
}

/** What `revert` sends to commitAsClaude: a composition change that puts version `want` back exactly. */
export interface RevertPlan {
	want: CompositionVersion;
	current: CompositionVersion;
	/** props to MERGE (null removes): the result equals the version's props exactly */
	props: Record<string, unknown>;
	/** the version's source, when it differs from the clip's (custom only) */
	source?: string;
	/** the version's length, when it differs from the clip's */
	duration_s?: number;
	note: string;
}

/**
 * Plan a revert (pure). `asked` = a version number or "previous"; `texts` = the store's bodies by sha (the version's
 * props + source); `clipSeconds` = the clip's current length. Errors are sentences a model can act on.
 */
export function planRevert(
	record: VersionedComposition,
	asked: unknown,
	texts: Map<string, string>,
	clipSeconds: number,
): { ok: true; plan: RevertPlan } | { ok: false; code: "not_found" | "unchanged" | "not_supported" | "not_in_store"; message: string } {
	const versions = versionsOf(record);
	const current = versions[versions.length - 1];
	const want = asked === "previous" ? versions[versions.length - 2] : versions.find((v) => v.v === Number(asked));
	if (!current || !want) return { ok: false, code: "not_found", message: `no version ${JSON.stringify(asked)}; there are ${versions.map((v) => `v${v.v}`).join(", ") || "none"}` };
	if (want.v === current.v) return { ok: false, code: "unchanged", message: `v${want.v} is already the current version` };
	if (want.kind === "library" && record.custom === true) {
		return { ok: false, code: "not_supported", message: `v${want.v} was the library composition ${want.name ?? ""} and the clip is custom code now: place the library piece again (composition write {library: "${want.name ?? ""}", props})` };
	}
	const propsText = texts.get(want.props_sha);
	const sourceText = want.source_sha ? texts.get(want.source_sha) : undefined;
	if (propsText === undefined || (want.kind === "custom" && sourceText === undefined)) {
		return { ok: false, code: "not_in_store", message: `v${want.v}'s ${propsText === undefined ? "props are" : "source is"} not in this server's composition store (made on another server, or before versions were kept)` };
	}
	const props = JSON.parse(propsText) as Record<string, unknown>;
	return {
		ok: true,
		plan: {
			want,
			current,
			props: propsPatch(record.props, props),
			...(want.kind === "custom" && sourceText !== undefined && sourceText !== record.source ? { source: sourceText } : {}),
			...(typeof want.duration === "number" && Math.abs(want.duration - clipSeconds) > 0.0005 ? { duration_s: want.duration } : {}),
			note: `revert to v${want.v}`,
		},
	};
}

// ─── the kit marker (pure) ──────────────────────────────────────────────────────────────────────────────────────

export const usesKitMarker = (source: unknown): boolean => typeof source === "string" && source.includes(KIT_MARKER);

/** The source with the kit marker in <head> (after <head>, else after the doctype / <html>, else first). */
export function withKitMarker(source: string): string {
	if (usesKitMarker(source)) return source;
	const head = /<head\b[^>]*>/i.exec(source);
	if (head) return `${source.slice(0, head.index + head[0].length)}\n${KIT_MARKER}${source.slice(head.index + head[0].length)}`;
	const lead = /^\s*(?:<!doctype[^>]*>\s*)?(?:<html\b[^>]*>)?/i.exec(source);
	const at = lead ? lead[0].length : 0;
	return `${source.slice(0, at)}${KIT_MARKER}\n${source.slice(at)}`;
}

// ─── the timeline kit on a snapshot (pure) ──────────────────────────────────────────────────────────────────────

export function timelineKitOf(snapshot: ProjectSnapshot | null | undefined): TimelineKitRecord | null {
	const restorff = snapshot?.metadata?.restorff as { kit?: unknown } | undefined;
	const kit = restorff?.kit as TimelineKitRecord | undefined;
	return kit && typeof kit.sha === "string" ? kit : null;
}

/** Point the snapshot at a new kit (keeps the previous ones in `history`, last 20). Mutates `snapshot`. */
export function setTimelineKit(snapshot: ProjectSnapshot, next: Omit<TimelineKitRecord, "history">): TimelineKitRecord {
	const meta = snapshot.metadata as { restorff?: Record<string, unknown> };
	const restorff = { ...((meta.restorff as Record<string, unknown> | undefined) ?? {}) };
	const before = timelineKitOf(snapshot);
	const history = [...(before?.history ?? []), ...(before ? [{ sha: before.sha, at: before.at, from: before.from }] : [])].slice(-20);
	const record: TimelineKitRecord = { ...next, ...(history.length ? { history } : {}) };
	restorff.kit = record;
	meta.restorff = restorff;
	return record;
}

function allTracks(scene: SnapshotScene): SnapshotTrack[] {
	return [...(scene.tracks?.overlay ?? []), ...(scene.tracks?.main ? [scene.tracks.main] : []), ...(scene.tracks?.audio ?? [])];
}

export function compositionOfElement(element: SnapshotElement): VersionedComposition | null {
	const c = (element.restorff as { composition?: unknown } | undefined)?.composition;
	return c && typeof c === "object" ? (c as VersionedComposition) : null;
}

/** Every composition clip on every scene: which include the timeline kit (custom code with the marker) and which not. */
export function kitClips(snapshot: ProjectSnapshot): { including: Array<{ element: SnapshotElement; track: SnapshotTrack }>; others: Array<{ element: SnapshotElement; track: SnapshotTrack }> } {
	const including: Array<{ element: SnapshotElement; track: SnapshotTrack }> = [];
	const others: Array<{ element: SnapshotElement; track: SnapshotTrack }> = [];
	for (const scene of snapshot.scenes ?? []) {
		for (const track of allTracks(scene)) {
			for (const element of track.elements ?? []) {
				const c = compositionOfElement(element);
				if (!c) continue;
				if (c.custom === true && usesKitMarker(c.source)) including.push({ element, track });
				else others.push({ element, track });
			}
		}
	}
	return { including, others };
}

// ─── the store ──────────────────────────────────────────────────────────────────────────────────────────────────

export const rcCompositionStore = pgTable("rc_composition_store", {
	sha: text("sha").primaryKey(),
	kind: text("kind").notNull(),
	body: text("body").notNull(),
	bytes: integer("bytes").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const DDL = [
	`CREATE TABLE IF NOT EXISTS rc_composition_store (
		sha text PRIMARY KEY,
		kind text NOT NULL,
		body text NOT NULL,
		bytes integer NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now()
	)`,
];
const READY_KEY = "__restorffcutCompositionStoreReady";
type GlobalWithReady = typeof globalThis & { [READY_KEY]?: Promise<void> };

async function db(): Promise<StoreDb> {
	const handle = await getDb();
	const g = globalThis as GlobalWithReady;
	if (!g[READY_KEY]) {
		g[READY_KEY] = (async () => {
			for (const statement of DDL) await handle.execute(sql.raw(statement));
		})().catch((error) => {
			delete g[READY_KEY];
			throw error;
		});
	}
	await g[READY_KEY];
	return handle;
}

/** The content-addressed store in the project database (sha256 of the body → body). Idempotent puts. */
export function dbStore(): BlobStore {
	return {
		async put(items) {
			const unique = new Map<string, { sha: string; kind: BlobKind; body: string; bytes: number }>();
			for (const item of items) {
				const sha = sha256(item.body);
				if (!unique.has(sha)) unique.set(sha, { sha, kind: item.kind, body: item.body, bytes: Buffer.byteLength(item.body, "utf8") });
			}
			if (unique.size) {
				const handle = await db();
				await handle.insert(rcCompositionStore).values([...unique.values()]).onConflictDoNothing();
			}
			return items.map((item) => sha256(item.body));
		},
		async get(shas) {
			const out = new Map<string, string>();
			const wanted = [...new Set(shas.filter((s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s)))];
			if (!wanted.length) return out;
			const handle = await db();
			const rows = await handle.select({ sha: rcCompositionStore.sha, body: rcCompositionStore.body }).from(rcCompositionStore).where(inArray(rcCompositionStore.sha, wanted));
			for (const row of rows) out.set(row.sha, row.body);
			return out;
		},
	};
}

/** An in-memory store (tests, dry runs). */
export function memoryStore(): BlobStore & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		async put(items) {
			for (const item of items) map.set(sha256(item.body), item.body);
			return items.map((item) => sha256(item.body));
		},
		async get(shas) {
			const out = new Map<string, string>();
			for (const sha of shas) if (map.has(sha)) out.set(sha, map.get(sha) as string);
			return out;
		},
	};
}

let defaultStore: BlobStore | null = null;
/** The store the server uses (the database); tests may swap it. */
export function compositionStore(): BlobStore {
	defaultStore ??= dbStore();
	return defaultStore;
}
export function useCompositionStore(store: BlobStore | null): void {
	defaultStore = store;
}

/** The timeline's kit as render input (from the store), or null when the timeline has none. */
export async function timelineKitInput(snapshot: ProjectSnapshot, store: BlobStore = compositionStore()): Promise<{ kit: KitInput; sha: string } | null> {
	const record = timelineKitOf(snapshot);
	if (!record) return null;
	const body = (await store.get([record.sha])).get(record.sha);
	if (body === undefined) throw new Error(`the timeline's kit ${record.sha.slice(0, 12)} is not in this server's composition store`);
	return { kit: kitFromBody(body), sha: record.sha };
}
