/**
 * Smoke test for RestorffCut's project store API against a RUNNING server.
 *
 *   cd apps/web
 *   bun scripts/api-smoke.ts                         # full flow on a new fictional project
 *   bun scripts/api-smoke.ts --base http://localhost:8791
 *   bun scripts/api-smoke.ts --push-as-claude <project id> [--text "ONE POUR."]
 *                                                    # one Claude commit on an existing project
 *                                                    # (GET head → ops@1 apply → POST), the way
 *                                                    # Restorff's gateway does it
 *
 * Flow: create → GET head → Claude commit (service token, ops@1 via @restorffcut/timeline-ops)
 * → stale push gets 409 with `since` → findings import (finding@1) pinned to tracks/elements
 * → a single comment → resolve → share link → public share GET + reviewer comment → branch
 * → wrong token gets 401. Exits 1 on the first failed check.
 *
 * The service token comes from env RESTORFFCUT_SERVICE_TOKEN, else from .env.local.
 * Fictional data only (Halcyon Cold Brew).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, type Op, type Project } from "@restorffcut/timeline-ops";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
const BASE = (arg("--base") ?? "http://localhost:8791").replace(/\/$/, "");
const TOKEN = process.env.RESTORFFCUT_SERVICE_TOKEN ?? readEnvLocal("RESTORFFCUT_SERVICE_TOKEN");
const T = 120_000;

function readEnvLocal(key: string): string | undefined {
	try {
		const text = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
		const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
		return line?.slice(key.length + 1).replace(/^"|"$/g, "").trim() || undefined;
	} catch {
		return undefined;
	}
}

let step = 0;
function check(ok: unknown, label: string, detail?: unknown): void {
	step++;
	if (ok) {
		console.log(`PASS ${String(step).padStart(2, "0")} ${label}`);
		return;
	}
	console.log(`FAIL ${String(step).padStart(2, "0")} ${label}`);
	if (detail !== undefined) console.log(JSON.stringify(detail, null, 2).slice(0, 2000));
	process.exit(1);
}

async function call(
	method: string,
	route: string,
	body?: unknown,
	opts: { token?: string | null } = {},
): Promise<{ status: number; json: any; auth: string | null }> {
	const token = opts.token === undefined ? TOKEN : opts.token;
	const res = await fetch(`${BASE}${route}`, {
		method,
		headers: {
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text.slice(0, 500) };
	}
	return { status: res.status, json, auth: res.headers.get("x-restorffcut-auth") };
}

/** A small fictional 9:16 project, shaped like the editor's SerializedProject v31. */
function halcyonProject(id: string): Project {
	const params = {
		"transform.positionX": 0,
		"transform.positionY": 0,
		"transform.scaleX": 1,
		"transform.scaleY": 1,
		"transform.rotate": 0,
		opacity: 1,
		blendMode: "normal",
		volume: 0,
		muted: false,
	};
	return {
		metadata: {
			id,
			name: "Halcyon Cold Brew / AD-014 (smoke)",
			duration: 12 * T,
			createdAt: "2026-10-20T09:00:00.000Z",
			updatedAt: "2026-10-20T09:00:00.000Z",
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{ id: "trk-text", name: "TEXT", type: "text", elements: [], hidden: false },
						{
							id: "trk-broll",
							name: "V2 B-ROLL",
							type: "video",
							muted: false,
							hidden: false,
							elements: [
								{
									id: "el-broll",
									type: "video",
									name: "S06 pour",
									mediaId: "media-broll",
									startTime: 5 * T,
									duration: 3 * T,
									trimStart: 0,
									trimEnd: 5 * T,
									sourceDuration: 8 * T,
									isSourceAudioEnabled: true,
									hidden: false,
									params: { ...params },
								},
							],
						},
					],
					main: {
						id: "trk-main",
						name: "V1 A-ROLL",
						type: "video",
						muted: false,
						hidden: false,
						elements: [
							{
								id: "el-aroll",
								type: "video",
								name: "S01 talking head",
								mediaId: "media-aroll",
								startTime: 0,
								duration: 12 * T,
								trimStart: 0,
								trimEnd: 0,
								sourceDuration: 12 * T,
								isSourceAudioEnabled: true,
								hidden: false,
								params: { ...params },
							},
						],
					},
					audio: [
						{
							id: "trk-music",
							name: "MUSIC",
							type: "audio",
							muted: false,
							elements: [
								{
									id: "el-music",
									type: "audio",
									sourceType: "upload",
									name: "morning-bed",
									mediaId: "media-music",
									startTime: 0,
									duration: 12 * T,
									trimStart: 0,
									trimEnd: 0,
									sourceDuration: 12 * T,
									params: { volume: -16, muted: false },
								},
							],
						},
					],
				},
				bookmarks: [],
				createdAt: "2026-10-20T09:00:00.000Z",
				updatedAt: "2026-10-20T09:00:00.000Z",
			},
		],
		currentSceneId: "scene-main",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			canvasSizeMode: "preset",
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	} as unknown as Project;
}

/** GET head → apply ops@1 → POST as claude. Returns the response. */
async function pushAsClaude(projectId: string, text: string, baseOverride?: string) {
	const head = await call("GET", `/api/projects/${encodeURIComponent(projectId)}`);
	if (head.status !== 200) return { head, push: null };
	const base = baseOverride ?? head.json.head.id;
	const ops: Op[] = [{ op: "text_pop", author: "claude", t: 0.3, text, dur: 1.5 } as Op];
	const result = apply(head.json.snapshot as Project, ops, {
		seed: `${projectId}/${base}`,
		at: new Date().toISOString(),
	});
	const push = await call("POST", `/api/projects/${encodeURIComponent(projectId)}/commits`, {
		base_commit: base,
		author: "claude",
		ops: result.changes.applied,
		snapshot: result.project,
		message: `hook headline '${text}' at 0:00.30`,
	});
	return { head, push, result };
}

async function main() {
	console.log(`RestorffCut API smoke · ${BASE} · service token ${TOKEN ? "set" : "NOT set (local dev mode only)"}`);

	const claudeTarget = arg("--push-as-claude");
	if (claudeTarget) {
		const { head, push } = await pushAsClaude(claudeTarget, arg("--text") ?? "ONE POUR.");
		check(head.status === 200, `GET /api/projects/${claudeTarget} → 200`, head.json);
		check(push?.status === 201, "POST commit as claude → 201", push?.json);
		console.log(`commit ${push!.json.commit.id.slice(0, 7)} · ${push!.json.commit.message}`);
		return;
	}

	const id = `smoke-halcyon-${Date.now().toString(36)}`;

	// 1. create
	const created = await call("POST", "/api/projects", {
		snapshot: halcyonProject(id),
		author: "compiler",
		message: "compiler v0",
	});
	check(created.status === 201, "POST /api/projects → 201", created.json);
	const root = created.json.commit;
	check(root.author === "compiler" && root.parents.length === 0, "root commit by compiler, no parents", root);

	// 2. head
	const head = await call("GET", `/api/projects/${id}`);
	check(head.status === 200 && head.json.head.id === root.id, "GET /api/projects/:id → head = root", head.json);
	check(head.json.snapshot?.metadata?.id === id, "head snapshot carries the project id");
	const dup = await call("POST", "/api/projects", { snapshot: halcyonProject(id) });
	check(dup.status === 409, "creating the same id again → 409", dup.json);

	// 3. Claude commit through ops@1
	const claude = await pushAsClaude(id, "ONE POUR.");
	check(claude.push?.status === 201, "POST commit as claude (ops@1 applied) → 201", claude.push?.json);
	const c1 = claude.push!.json.commit;
	check(c1.parents[0] === root.id && c1.author === "claude", "claude commit's parent is the root", c1);
	check(c1.summary?.elementsAdded === 1, `diff summary: ${JSON.stringify(c1.summary?.lines)}`, c1.summary);

	// 4. conflict: push again from the stale root
	const stale = await pushAsClaude(id, "TWENTY HOURS.", root.id);
	check(stale.push?.status === 409, "stale base_commit → 409", stale.push?.json);
	const conflict = stale.push!.json.conflict;
	check(
		conflict.head.id === c1.id && conflict.since.length === 1 && conflict.since[0].id === c1.id,
		"409 names the head and the commits since the base",
		conflict,
	);

	// 5. user commit on top (browser-shaped) and history
	const snap = (await call("GET", `/api/projects/${id}`)).json.snapshot;
	snap.scenes[0].tracks.main.elements[0].params.volume = -2;
	const user = await call("POST", `/api/projects/${id}/commits`, {
		base_commit: c1.id,
		author: "user",
		snapshot: snap,
		message: "voice -2 dB",
	});
	check(user.status === 201, "POST commit as user → 201", user.json);
	const history = await call("GET", `/api/projects/${id}/commits`);
	check(
		history.status === 200 && history.json.commits.map((c: any) => c.author).join(",") === "user,claude,compiler",
		"GET commits → newest first: user, claude, compiler",
		history.json,
	);
	const since = await call("GET", `/api/projects/${id}/commits?since=${root.id}`);
	check(since.json.commits.length === 2, "GET commits?since=root → 2 newer commits", since.json);
	const one = await call("GET", `/api/projects/${id}/commits/${c1.id.slice(0, 7)}`);
	check(one.status === 200 && one.json.commit.snapshot && Array.isArray(one.json.commit.ops), "GET one commit by 7-char prefix → snapshot + ops", one.json);

	// 6. findings import (finding@1, docs/restorff/EXPORT-GATE.md §4)
	const findings = [
		{
			id: "ad014-c2-CLEAN-03", rule: "CLEAN", severity: "must", status: "open",
			t: 5.37, t_end: 6.0, track: null, element_id: null,
			measure: { frozen_s: 0.63, frozen_total_s: 0.63 },
			target: "no held frames >= 0.2 s (total < 0.5 s)", evidence: "MEASURED",
			message: "picture held still for 0.63 s",
			fix: "the clip is shorter than its slot: trim the slot, extend the clip, or add a camera move",
			source: "worker:judge@0.1.0", file: "ad014-c2.mp4",
		},
		{
			id: "ad014-c2-R3-01", rule: "R3", severity: "should", status: "open",
			t: 0, t_end: null, track: "TEXT", evidence: "READ",
			message: "the hook headline is 9 words", fix: "7 or fewer words, in by 0.3 s",
			source: "judge:restorff-craft@0.1.0",
		},
		{ id: "broken", rule: "R5" },
	];
	const imported = await call("POST", `/api/projects/${id}/comments`, findings);
	check(imported.status === 201 && imported.json.comments.length === 2, "POST findings → 2 comments", imported.json);
	check(imported.json.errors.length === 1 && imported.json.errors[0].id === "broken", "the malformed finding is reported, not stored", imported.json.errors);
	const clean = imported.json.comments.find((c: any) => c.rule_id === "CLEAN");
	check(
		clean.track_name === "V2 B-ROLL" && clean.element_id === "el-broll" && clean.severity === "must",
		"CLEAN with track null → pinned to the top video element at 5.37 s (V2 B-ROLL / el-broll)",
		clean,
	);
	const r3 = imported.json.comments.find((c: any) => c.rule_id === "R3");
	check(r3.track_id === "trk-text", "R3 → TEXT track", r3);
	const again = await call("POST", `/api/projects/${id}/comments`, { findings: [findings[0]] });
	check(again.json.comments[0].id === clean.id, "re-importing a finding updates it (same comment id)", again.json);

	const single = await call("POST", `/api/projects/${id}/comments`, {
		time_s: 8.5, body: "music swells too early", track_name: "MUSIC", severity: "could",
	});
	check(single.status === 201 && single.json.comments[0].track_id === "trk-music", "POST single comment → pinned to MUSIC", single.json);
	const resolved = await call("PATCH", `/api/projects/${id}/comments`, { id: single.json.comments[0].id, status: "resolved" });
	check(resolved.status === 200 && resolved.json.comment.status === "resolved", "PATCH comment → resolved", resolved.json);
	const open = await call("GET", `/api/projects/${id}/comments?status=open`);
	check(open.json.comments.length === 2, "GET comments?status=open → 2", open.json);

	// 7. share link
	const share = await call("POST", "/api/share", { project_id: id, can_comment: true, expires_in: "7d" });
	check(share.status === 201 && share.json.token && share.json.url.includes("/shared/"), "POST /api/share → 201 token + url", share.json);
	const pub = await call("GET", `/api/share/${share.json.token}`, undefined, { token: null });
	check(
		pub.status === 200 && pub.json.commit.id === user.json.commit.id && pub.json.comments.length === 3,
		"GET /api/share/:token (no auth) → head snapshot + 3 comments",
		pub.json,
	);
	const reviewer = await call(
		"POST",
		`/api/share/${share.json.token}/comments`,
		{ author: "Ines (editor)", body: "cut S06 a beat earlier", time_s: 5.1, track_id: "trk-broll" },
		{ token: null },
	);
	check(reviewer.status === 201 && reviewer.json.comment.element_id === "el-broll", "reviewer comment via link → pinned to el-broll", reviewer.json);
	const pinned = await call("POST", "/api/share", { project_id: id, commit_id: root.id, can_comment: false });
	const pinnedView = await call("GET", `/api/share/${pinned.json.token}`, undefined, { token: null });
	check(pinnedView.json.commit.id === root.id && pinnedView.json.head.id !== root.id, "pinned link shows its commit, not the head", pinnedView.json.commit);
	const viewOnly = await call("POST", `/api/share/${pinned.json.token}/comments`, { author: "x", body: "y", time_s: 1 }, { token: null });
	check(viewOnly.status === 403, "view-only link refuses comments → 403", viewOnly.json);
	const revoke = await call("DELETE", `/api/share?id=${pinned.json.link.id}`);
	const gone = await call("GET", `/api/share/${pinned.json.token}`, undefined, { token: null });
	check(revoke.status === 200 && gone.status === 404, "revoked link → 404", gone.json);

	// 7b. media (content-addressed; bytes are a fictional stand-in, not a real video)
	const bytes = new TextEncoder().encode("halcyon-cold-brew-pour-".repeat(400));
	const meta = Buffer.from(JSON.stringify({ id: "media-broll", name: "halcyon-pour.mp4", type: "video", size: bytes.length, lastModified: 0, width: 1080, height: 1920, duration: 8 })).toString("base64url");
	const put = await fetch(`${BASE}/api/projects/${id}/media/media-broll`, {
		method: "PUT",
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "video/mp4", "X-Media-Meta": meta },
		body: bytes,
	});
	const putJson = (await put.json()) as any;
	check(put.status === 201 && putJson.media.size === bytes.length && putJson.media.hash.length === 64, "PUT media → 201, sha256 + size", putJson);
	const put2 = await fetch(`${BASE}/api/projects/${id}/media/media-broll-copy`, {
		method: "PUT",
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "video/mp4" },
		body: bytes,
	});
	check(((await put2.json()) as any).media.hash === putJson.media.hash, "same bytes under another id → same hash (stored once)");
	const list = await call("GET", `/api/projects/${id}/media`);
	check(list.json.media.length === 2 && list.json.media.find((m: any) => m.media_id === "media-broll")?.meta?.name === "halcyon-pour.mp4", "GET media → 2 entries with meta", list.json);
	const ranged = await fetch(`${BASE}/api/share/${share.json.token}/media/media-broll`, { headers: { Range: "bytes=0-99" } });
	const rangedBody = await ranged.arrayBuffer();
	check(ranged.status === 206 && rangedBody.byteLength === 100, "share media with Range → 206, 100 bytes (no auth, token only)", ranged.status);
	const sharedAgain = await call("GET", `/api/share/${share.json.token}`, undefined, { token: null });
	check(sharedAgain.json.media?.["media-broll"]?.mime === "video/mp4", "share payload lists the media", sharedAgain.json.media);

	// 8. branches
	const branch = await call("POST", `/api/projects/${id}/branches`, { name: "alt-hook", from_commit: root.id });
	check(branch.status === 201, "POST branch alt-hook from root → 201", branch.json);
	const onBranch = await pushAsClaude(id, "NEVER BITTER.", undefined);
	check(onBranch.push?.status === 201, "main still accepts commits", onBranch.push?.json);
	const branches = await call("GET", `/api/projects/${id}/branches`);
	check(branches.json.branches.length === 2, "GET branches → main + alt-hook", branches.json);
	const onAlt = await call("POST", `/api/projects/${id}/commits`, {
		base_commit: root.id,
		branch: "alt-hook",
		author: "claude",
		ops: [{ op: "text_pop", author: "claude", t: 0.2, text: "TWENTY HOURS.", dur: 1.2 }],
		message: "alt hook headline (ops only)",
	});
	check(
		onAlt.status === 201 && onAlt.json.branch === "alt-hook" && onAlt.json.changes?.ops?.[0]?.status === "applied",
		"ops-only push on alt-hook → 201, the server ran the reducer",
		onAlt.json,
	);
	const refused = await call("POST", `/api/projects/${id}/commits`, {
		base_commit: onAlt.json.commit.id,
		branch: "alt-hook",
		author: "claude",
		ops: [{ op: "delete", author: "claude", el: "no-such-element" }],
		message: "delete a ghost",
	});
	check(refused.status === 422 && refused.json.conflicts?.length === 1, "ops the reducer refuses → 422, nothing committed", refused.json);

	// 9. auth
	const bad = await call("GET", `/api/projects/${id}`, undefined, { token: "not-the-token" });
	check(bad.status === 401, "wrong bearer token → 401", bad.json);

	console.log(`\nall ${step} checks passed · project ${id} · auth mode on this server: ${head.auth}`);
	console.log(`open it in the editor: ${BASE}/editor/${id}`);
	console.log(`review link: ${share.json.url}`);
}

main().catch((error) => {
	console.error("smoke crashed:", error);
	process.exit(1);
});
