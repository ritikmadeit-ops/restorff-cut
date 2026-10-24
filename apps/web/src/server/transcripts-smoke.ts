#!/usr/bin/env bun
/**
 * Set up a scratch timeline for the MCP talking-head tools (mcp-cut agent, 2026-10-20): a fictional Halcyon Cold Brew
 * project on the RUNNING dev server, one video clip on V1 A-ROLL, and the video file uploaded to the server's media
 * store — what an editor does when version history is on. Then drive `transcribe` → `autocut` → `captions` with
 * `bun scripts/mcp-call.ts` (worklog docs/restorff/worklog/mcp-cut.md has the exact calls).
 *
 *   bun apps/web/src/server/transcripts-smoke.ts <video> [--name "talking-head-raw.mp4"] [--base http://localhost:8791]
 *
 * Prints one JSON line: {timeline_id, element_id, media_id, head, duration_s, size, sha256}. Exit 1 on any failure.
 * Auth: Bearer RESTORFFCUT_SERVICE_TOKEN (env, else apps/web/.env.local — never printed); else local-dev mode.
 * The video stays local: the server stores it under apps/web/.data/media (git-ignored). Third-party reels may be used
 * as local test input only (BUILD-BRIEF §6 rule 11).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EDITOR_PROJECT_VERSION } from "@restorffcut/timeline-ops";

const argv = process.argv.slice(2);
const flag = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const video = argv.find((value, i) => !value.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
if (!video) {
	console.error("usage: bun apps/web/src/server/transcripts-smoke.ts <video> [--name <file name>] [--base <url>]");
	process.exit(2);
}
const BASE = (flag("--base") ?? process.env.RESTORFFCUT_URL ?? "http://localhost:8791").replace(/\/$/, "");
const NAME = flag("--name") ?? "talking-head-raw.mp4";
const T = 120_000;

function token(): string | undefined {
	if (process.env.RESTORFFCUT_SERVICE_TOKEN) return process.env.RESTORFFCUT_SERVICE_TOKEN;
	try {
		const env = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.local");
		const line = readFileSync(env, "utf8").split(/\r?\n/).find((l) => l.startsWith("RESTORFFCUT_SERVICE_TOKEN="));
		return line?.slice("RESTORFFCUT_SERVICE_TOKEN=".length).replace(/^"|"$/g, "").trim() || undefined;
	} catch {
		return undefined;
	}
}
const TOKEN = token();

function die(message: string, detail?: unknown): never {
	console.error(message);
	if (detail !== undefined) console.error(JSON.stringify(detail, null, 1).slice(0, 2000));
	process.exit(1);
}

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}, raw?: Uint8Array) {
	const res = await fetch(`${BASE}${route}`, {
		method,
		headers: {
			...(body !== undefined ? { "content-type": "application/json" } : {}),
			...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
			...headers,
		},
		body: raw ? (raw as unknown as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text.slice(0, 400) };
	}
	return { status: res.status, json };
}

// 1. probe
const probe = spawnSync(process.env.FFPROBE || "ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", video], { encoding: "utf8" });
if (probe.status !== 0) die(`ffprobe failed on ${video}: ${probe.stderr}`);
const info = JSON.parse(probe.stdout) as { format: { duration?: string }; streams: Array<Record<string, string | number | undefined>> };
const v = info.streams.find((s) => s.codec_type === "video");
const a = info.streams.find((s) => s.codec_type === "audio");
if (!v) die(`${video} has no video stream`);
const [fn, fd] = String(v.avg_frame_rate ?? v.r_frame_rate ?? "30/1").split("/").map(Number);
const fps = fn && fd ? fn / fd : 30;
const frames = v.nb_frames ? Number(v.nb_frames) : null;
// the decodable video length (frames / fps), as the pipeline does, so the last frame is never a hold
const duration = Math.floor((frames ? frames / fps : Number(v.duration ?? info.format.duration ?? 0)) * T) / T;
const bytes = new Uint8Array(readFileSync(video));
const sha = createHash("sha256").update(bytes).digest("hex");

// 2. project (empty 9:16, Halcyon), then import + place the clip with ops@1 (the reducer makes the element)
const id = `halcyon-cut-${Date.now().toString(36)}`;
const now = new Date().toISOString();
const snapshot = {
	metadata: { id, name: "Halcyon Cold Brew / AD-021 talking head (scratch)", duration: 0, createdAt: now, updatedAt: now },
	scenes: [
		{
			id: "scene-main",
			name: "Main scene",
			isMain: true,
			tracks: { overlay: [], main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] }, audio: [] },
			bookmarks: [],
			createdAt: now,
			updatedAt: now,
		},
	],
	currentSceneId: "scene-main",
	settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "preset", background: { type: "color", color: "#000000" } },
	version: EDITOR_PROJECT_VERSION,
	timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
};
const created = await call("POST", "/api/projects", { snapshot, author: "user", message: "scratch timeline for the MCP talking-head tools" });
if (created.status !== 201) die(`POST /api/projects → ${created.status}`, created.json);
const base = created.json.commit.id as string;
const placed = await call("POST", `/api/projects/${id}/commits`, {
	base_commit: base,
	author: "user",
	message: "talking head on V1 A-ROLL",
	ops: [
		{ op: "import_media", author: "user", kind: "video", name: NAME, blob_sha: sha, duration, width: Number(v.width), height: Number(v.height), fps, has_audio: !!a, ref: "src" },
		{ op: "insert", author: "user", track: "main", t: 0, media: "src", in: 0, out: duration, name: "S01 talking head", ref: "aroll" },
	],
});
if (placed.status !== 201) die(`ops commit → ${placed.status}`, placed.json);
const mediaId = placed.json.changes.refs.src as string;
const elementId = placed.json.changes.refs.aroll as string;

// 3. upload the file under the media id the clip plays (as the editor's version history does)
const meta = { name: NAME, type: "video", size: bytes.byteLength, lastModified: statSync(video).mtimeMs, width: Number(v.width), height: Number(v.height), duration, fps, hasAudio: !!a };
const put = await call(
	"PUT",
	`/api/projects/${id}/media/${mediaId}`,
	undefined,
	{ "content-type": "video/mp4", "x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"), "x-media-sha256": sha },
	bytes,
);
if (put.status !== 201) die(`PUT media → ${put.status}`, put.json);

console.log(JSON.stringify({ timeline_id: id, element_id: elementId, media_id: mediaId, head: placed.json.commit.id, duration_s: duration, size: bytes.byteLength, sha256: sha }));
