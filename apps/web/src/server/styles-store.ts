/**
 * Saved styles server-side (EDT-20; mcp-review agent, 2026-10-20). Until now saved styles lived only in one browser's
 * localStorage, so a Claude over MCP could not list, apply or save them. Three tables in the project store:
 *
 *   rc_saved_styles   one row per (owner, style id): the current SavedStyle + its older versions; tombstoned on delete
 *   rc_style_dismissed  repeat patterns the owner said "no" to
 *   rc_style_history  instructions (sentence + compacted ops) from the browser's command bar and MCP `revise`,
 *                     which repeat detection (`detectRepeats`) counts
 *
 * Owner = whose library (security-pass, 2026-10-21; `styleOwner` below): a Restorff org's (`org:<id>`, from the
 * gateway's X-Restorff-Org behind the service token), a signed-in user's own, a header-less service call's dedicated
 * `service:no-org` (dev; production refuses it), else (local dev) the project's owner or the caller. Before that, every service-token project's owner was "service", so every
 * Restorff org shared one library; those rows were moved to LEGACY_SERVICE_OWNER, which nobody reads.
 *
 * Tables are created here with CREATE TABLE IF NOT EXISTS on first use (once per process), not in
 * lib/db/store-migrations.ts: several wave-4 agents add tables at once and the migration ids would collide (two
 * "id: 3" = one silently skipped). The orchestrator may fold this DDL into a numbered migration at integration.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
	detectRepeats,
	draftStyle,
	emptyLibrary,
	opShape,
	saveStyle,
	validateStylePreset,
	type InstructionRecord,
	type RepeatSuggestion,
	type SavedStyle,
	type StyleLibrary,
} from "@restorffcut/styles";
import type { Op } from "@restorffcut/timeline-ops";
import { getDb, rowsOf, type StoreDb } from "@/lib/db/store";
import { rcProjects } from "@/lib/db/store-schema";
import type { Actor } from "./auth";
import { HttpError, iso } from "./http";
import { HISTORY_CAP, mergeLibraries, normaliseLibrary } from "./styles-store-merge";
import { currentOrg } from "./tenant";

// ─── tables ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const rcSavedStyles = pgTable(
	"rc_saved_styles",
	{
		owner: text("owner").notNull(),
		styleId: text("style_id").notNull(),
		version: text("version").notNull(),
		title: text("title").notNull(),
		style: jsonb("style").$type<SavedStyle>().notNull(),
		versions: jsonb("versions").$type<SavedStyle[]>().notNull().default([]),
		projectId: text("project_id"),
		savedBy: text("saved_by"),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.owner, table.styleId] })],
);

export const rcStyleDismissed = pgTable(
	"rc_style_dismissed",
	{
		owner: text("owner").notNull(),
		pattern: text("pattern").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.owner, table.pattern] })],
);

export const rcStyleHistory = pgTable("rc_style_history", {
	id: text("id").primaryKey(),
	owner: text("owner").notNull(),
	projectId: text("project_id"),
	sentence: text("sentence").notNull(),
	ops: jsonb("ops").$type<Op[]>().notNull().default([]),
	clauses: jsonb("clauses").$type<Array<{ text: string; ops: Op[] }>>(),
	source: text("source").notNull().default("mcp"),
	at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

const DDL = [
	`CREATE TABLE IF NOT EXISTS rc_saved_styles (
		owner text NOT NULL,
		style_id text NOT NULL,
		version text NOT NULL,
		title text NOT NULL,
		style jsonb NOT NULL,
		versions jsonb NOT NULL DEFAULT '[]'::jsonb,
		project_id text,
		saved_by text,
		deleted_at timestamptz,
		created_at timestamptz NOT NULL DEFAULT now(),
		updated_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (owner, style_id)
	)`,
	`CREATE TABLE IF NOT EXISTS rc_style_dismissed (
		owner text NOT NULL,
		pattern text NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (owner, pattern)
	)`,
	`CREATE TABLE IF NOT EXISTS rc_style_history (
		id text PRIMARY KEY,
		owner text NOT NULL,
		project_id text,
		sentence text NOT NULL,
		ops jsonb NOT NULL DEFAULT '[]'::jsonb,
		clauses jsonb,
		source text NOT NULL DEFAULT 'mcp',
		at timestamptz NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS rc_style_history_owner_idx ON rc_style_history (owner, at)`,
];

const READY_KEY = "__restorffcutStylesStoreReady";
// its own key (security-pass, 2026-10-21): a dev server that already ran the DDL still runs the org-scope migration
const SCOPED_KEY = "__restorffcutStylesOrgScoped";
type GlobalWithReady = typeof globalThis & { [READY_KEY]?: Promise<void>; [SCOPED_KEY]?: Promise<unknown> };

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
	if (!g[SCOPED_KEY]) {
		g[SCOPED_KEY] = migrateServiceOwner(handle).catch((error) => {
			delete g[SCOPED_KEY];
			throw error;
		});
	}
	await g[SCOPED_KEY];
	return handle;
}

// ─── owner ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A Restorff org's library (security-pass, 2026-10-21): `org:<org id>` from X-Restorff-Org. */
export const ORG_OWNER_PREFIX = "org:";
/**
 * Where the rows the shared "service" owner held before org scoping went (one-time migration below): mixed from every
 * org, so nobody reads them — no caller resolves to this owner (org callers get org:…, sessions their user id, a
 * header-less service call service:no-org, local dev "local-dev" or the project's owner).
 */
export const LEGACY_SERVICE_OWNER = "legacy:service-shared";
/** Dev only: a service-token call with no org (the operator's scripts). Production refuses such a call instead. */
export const SERVICE_NO_ORG_OWNER = "service:no-org";

/**
 * Whose library (security-pass, 2026-10-21 — was "the project's owner, else the caller", and every service-token
 * project's owner is "service", so every Restorff org shared one library):
 *   - the service token with an org (X-Restorff-Org; the gateway always sends it) → `org:<org>`, whatever the project
 *   - the service token WITHOUT an org (independent review F2, 2026-10-23): never the project's owner or "service"
 *     again — in production a 400 (fail closed: a gateway that lost the header must not share one library); in dev
 *     the dedicated SERVICE_NO_ORG_OWNER, so the operator's own scripts (scripts/mcp-call.ts, mcp-run.ts) still work
 *   - a signed-in browser session → that user's own library
 *   - local dev → the project's owner, else the caller
 */
export async function styleOwner(actor: Actor | null, projectId?: string | null): Promise<string> {
	if (actor?.kind === "service") {
		const org = actor.org ?? currentOrg();
		if (org) return `${ORG_OWNER_PREFIX}${org}`;
		if (process.env.NODE_ENV === "production") {
			throw new HttpError(400, "saved styles need the org: a service-token call sends X-Restorff-Org", { reason: "org_required" });
		}
		return SERVICE_NO_ORG_OWNER;
	}
	if (actor?.kind === "user") return actor.id;
	if (projectId) {
		const handle = await db();
		const [row] = await handle.select({ owner: rcProjects.owner }).from(rcProjects).where(eq(rcProjects.id, projectId)).limit(1);
		if (row?.owner) return row.owner;
	}
	return actor?.id ?? "local-dev";
}

/**
 * One-time (marker row in rc_styles_migrations): the shared "service" library — saved styles, dismissals, history —
 * moves to LEGACY_SERVICE_OWNER. Exported for tests; db() runs it once per process before any read or write.
 */
export async function migrateServiceOwner(handle: StoreDb): Promise<{ migrated: boolean; styles: number; dismissed: number; history: number }> {
	await handle.execute(sql.raw("CREATE TABLE IF NOT EXISTS rc_styles_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"));
	return handle.transaction(async (tx) => {
		const claimed = rowsOf(await tx.execute(sql`INSERT INTO rc_styles_migrations (id) VALUES ('org-scope-1') ON CONFLICT (id) DO NOTHING RETURNING id`));
		if (!claimed.length) return { migrated: false, styles: 0, dismissed: 0, history: 0 };
		const moved = async (table: string) =>
			rowsOf(await tx.execute(sql.raw(`UPDATE ${table} SET owner = '${LEGACY_SERVICE_OWNER}' WHERE owner = 'service' RETURNING owner`))).length;
		const styles = await moved("rc_saved_styles");
		const dismissed = await moved("rc_style_dismissed");
		const history = await moved("rc_style_history");
		if (styles || dismissed || history) console.log(`[styles-store] org scoping: moved the shared "service" library to ${LEGACY_SERVICE_OWNER} (${styles} styles, ${dismissed} dismissals, ${history} history rows)`);
		return { migrated: true, styles, dismissed, history };
	});
}

// ─── library ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ServerLibrary {
	owner: string;
	library: StyleLibrary;
	/** Style id → ISO time it was deleted (tombstones, so a browser does not bring a deleted style back). */
	deleted: Record<string, string>;
}

export async function getLibrary(owner: string): Promise<ServerLibrary> {
	const handle = await db();
	const rows = await handle.select().from(rcSavedStyles).where(eq(rcSavedStyles.owner, owner));
	const dismissed = await handle.select({ pattern: rcStyleDismissed.pattern }).from(rcStyleDismissed).where(eq(rcStyleDismissed.owner, owner));
	const library = emptyLibrary();
	const deleted: Record<string, string> = {};
	for (const row of rows) {
		if (row.deletedAt) {
			deleted[row.styleId] = iso(row.deletedAt) ?? new Date(0).toISOString();
			continue;
		}
		library.styles[row.styleId] = row.style;
		if (Array.isArray(row.versions) && row.versions.length) library.versions[row.styleId] = row.versions;
	}
	library.dismissed = dismissed.map((d) => d.pattern);
	return { owner, library, deleted };
}

async function writeStyle(owner: string, style: SavedStyle, versions: SavedStyle[], meta: { projectId?: string | null; savedBy?: string | null }): Promise<void> {
	const handle = await db();
	const now = new Date();
	await handle
		.insert(rcSavedStyles)
		.values({
			owner,
			styleId: style.id,
			version: style.version,
			title: style.title,
			style,
			versions,
			projectId: meta.projectId ?? null,
			savedBy: meta.savedBy ?? null,
			deletedAt: null,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [rcSavedStyles.owner, rcSavedStyles.styleId],
			set: {
				version: style.version,
				title: style.title,
				style,
				versions,
				...(meta.projectId ? { projectId: meta.projectId } : {}),
				...(meta.savedBy ? { savedBy: meta.savedBy } : {}),
				deletedAt: null,
				updatedAt: now,
			},
		});
}

/**
 * The browser pushes its whole library (on save, delete, import, and once after it pulls): merged into the server's
 * (mergeLibraries: higher version wins, nothing lost), written back, and returned so the browser can take it.
 */
export async function syncLibrary(owner: string, incoming: unknown, meta: { projectId?: string | null; savedBy?: string | null } = {}): Promise<ServerLibrary & { taken: string[] }> {
	const current = await getLibrary(owner);
	const merged = mergeLibraries(current.library, normaliseLibrary(incoming), current.deleted);
	for (const id of merged.taken) {
		const style = merged.library.styles[id];
		if (!style || validateStylePreset(style).length) continue;
		await writeStyle(owner, style, merged.library.versions[id] ?? [], meta);
	}
	const handle = await db();
	for (const pattern of merged.library.dismissed) {
		if (!current.library.dismissed.includes(pattern)) {
			await handle.insert(rcStyleDismissed).values({ owner, pattern }).onConflictDoNothing();
		}
	}
	const after = await getLibrary(owner);
	return { ...after, taken: merged.taken };
}

/**
 * Save one style (Claude over MCP, or the browser's Save): same id → a new version (the old one kept), identical
 * content → unchanged. Throws 400 with the problems when the style is not a valid edit-style preset.
 */
export async function saveOwnerStyle(
	owner: string,
	style: SavedStyle,
	meta: { projectId?: string | null; savedBy?: string | null; note?: string } = {},
): Promise<{ style: SavedStyle; changed: boolean; versions: SavedStyle[] }> {
	const problems = validateStylePreset(style);
	if (problems.length) throw new HttpError(400, `invalid style: ${problems.join("; ")}`, { problems });
	const { library } = await getLibrary(owner);
	const result = saveStyle(library, style, { note: meta.note });
	const versions = result.library.versions[style.id] ?? [];
	if (result.changed) await writeStyle(owner, result.style, versions, meta);
	return { style: result.style, changed: result.changed, versions };
}

export async function deleteOwnerStyle(owner: string, id: string): Promise<boolean> {
	const handle = await db();
	const rows = await handle
		.update(rcSavedStyles)
		.set({ deletedAt: new Date(), updatedAt: new Date() })
		.where(and(eq(rcSavedStyles.owner, owner), eq(rcSavedStyles.styleId, id), isNull(rcSavedStyles.deletedAt)))
		.returning({ id: rcSavedStyles.styleId });
	return rows.length > 0;
}

export async function dismissOwnerPattern(owner: string, pattern: string): Promise<void> {
	const handle = await db();
	await handle.insert(rcStyleDismissed).values({ owner, pattern }).onConflictDoNothing();
}

// ─── history + repeat suggestions ───────────────────────────────────────────────────────────────────────────────

/** First op of each distinct shape (what repeat detection and drafting need; keeps rows small — styles-lab/history.ts). */
export function compactOps(ops: readonly Op[]): Op[] {
	const seen = new Set<string>();
	const out: Op[] = [];
	for (const op of ops ?? []) {
		let shape: string;
		try {
			shape = opShape(op);
		} catch {
			continue;
		}
		if (seen.has(shape)) continue;
		seen.add(shape);
		out.push(op);
	}
	return out;
}

export async function recordOwnerInstruction(
	owner: string,
	record: { sentence: string; ops: readonly Op[]; clauses?: ReadonlyArray<{ text: string; ops: readonly Op[] }>; projectId?: string | null; at?: string },
	source: "mcp" | "browser",
): Promise<InstructionRecord | null> {
	const sentence = record.sentence?.trim();
	if (!sentence) return null;
	const handle = await db();
	const at = record.at && !Number.isNaN(Date.parse(record.at)) ? new Date(record.at) : new Date();
	const ops = compactOps(record.ops ?? []);
	const clauses = record.clauses?.length ? record.clauses.map((clause) => ({ text: clause.text, ops: compactOps(clause.ops ?? []) })) : null;
	// the browser re-sends what it pulled: (owner, at, sentence) is one record
	const existing = await handle
		.select({ id: rcStyleHistory.id })
		.from(rcStyleHistory)
		.where(and(eq(rcStyleHistory.owner, owner), eq(rcStyleHistory.at, at), eq(rcStyleHistory.sentence, sentence)))
		.limit(1);
	if (!existing.length) {
		await handle.insert(rcStyleHistory).values({ id: randomUUID(), owner, projectId: record.projectId ?? null, sentence, ops, clauses, source, at });
	}
	return { sentence, ops, ...(clauses ? { clauses } : {}), ...(record.projectId ? { projectId: record.projectId } : {}), at: at.toISOString() };
}

export async function listOwnerHistory(owner: string, limit = HISTORY_CAP): Promise<Array<InstructionRecord & { source: string }>> {
	const handle = await db();
	const rows = await handle.select().from(rcStyleHistory).where(eq(rcStyleHistory.owner, owner)).orderBy(desc(rcStyleHistory.at)).limit(Math.min(Math.max(limit, 1), 1000));
	return rows.reverse().map((row) => ({
		sentence: row.sentence,
		ops: (row.ops ?? []) as Op[],
		...(row.clauses ? { clauses: row.clauses } : {}),
		...(row.projectId ? { projectId: row.projectId } : {}),
		at: iso(row.at) ?? undefined,
		source: row.source,
	}));
}

/** "Save as a style?" suggestions from the owner's history (≥ threshold repeats; saved and dismissed ones skipped). */
export async function ownerSuggestions(owner: string, options: { threshold?: number; by?: "records" | "projects"; limit?: number } = {}): Promise<RepeatSuggestion[]> {
	const [history, { library }] = await Promise.all([listOwnerHistory(owner), getLibrary(owner)]);
	return detectRepeats(history, { threshold: options.threshold ?? 3, by: options.by ?? "records", library, limit: options.limit ?? 3 });
}

/** A style from a plain sentence (re-resolved on each project it is applied to) — for `styles save` over MCP. */
export function styleFromSentence(args: { title: string; sentence: string; triggers?: string[]; projectId?: string | null }): SavedStyle {
	return draftStyle(
		{ records: [{ sentence: args.sentence, ops: [], ...(args.projectId ? { projectId: args.projectId } : {}) }], title: args.title, triggers: args.triggers?.length ? args.triggers : [args.sentence] },
		{},
	);
}
