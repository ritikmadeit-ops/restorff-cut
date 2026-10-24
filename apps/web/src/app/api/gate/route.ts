/**
 * The file half of the export gate (docs/restorff/EXPORT-GATE.md §2: LOUD, CLEAN black/held, FORMAT).
 *
 * POST /api/gate?w=1080&h=1920&fps=30&name=AD-014.mp4[&require_h264_aac=0]
 *   body: the exported file's bytes (Content-Type video/mp4 or video/webm), at most RESTORFFCUT_GATE_MAX_MB (400)
 *   200 {measures: FileMeasures, run: CheckRun}   — findings are finding@1 (evidence MEASURED)
 *   413 too big · 400 bad request · 401 not allowed (same rule as the project store: local dev, a session, or the
 *   service token)
 * GET /api/gate → {ffmpeg, ffprobe, max_mb, dir} so the editor can say "file checks unavailable" up front.
 *
 * The upload is streamed into <apps/web>/.data/gate/<uuid>/ (git-ignored), measured with ffprobe + ffmpeg, then
 * deleted (unless RESTORFFCUT_GATE_KEEP=1). Nothing is kept or sent anywhere.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileFindings } from "@restorffcut/gate";
import { GATE_KEEP, GATE_MAX_BYTES, measureFile, resolveGateDir, toolVersions } from "@/gate/server/ffmpeg";
import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function positive(value: string | null, field: string, fallback?: number): number {
	if (value === null || value === "") {
		if (fallback !== undefined) return fallback;
		throw new HttpError(400, `${field} is required`);
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${field} must be a positive number`);
	return n;
}

function safeName(name: string | null, contentType: string | null): string {
	const ext = /webm/i.test(contentType ?? "") || /\.webm$/i.test(name ?? "") ? ".webm" : ".mp4";
	const stem = (name ?? "render").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "render";
	return `${stem}${ext}`;
}

async function writeBody(request: Request, file: string): Promise<number> {
	if (!request.body) throw new HttpError(400, "the body must be the exported file");
	const out = createWriteStream(file);
	let bytes = 0;
	const reader = request.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > GATE_MAX_BYTES) {
				throw new HttpError(413, `the file is larger than ${Math.round(GATE_MAX_BYTES / 1024 / 1024)} MB`);
			}
			if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
		}
	} finally {
		await new Promise<void>((r) => out.end(() => r()));
		reader.releaseLock();
	}
	return bytes;
}

export const GET = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const tools = await toolVersions();
	return json(
		{ ...tools, max_mb: Math.round(GATE_MAX_BYTES / 1024 / 1024), dir: ".data/gate" },
		200,
		authHeaders(actor),
	);
});

export const POST = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const q = new URL(request.url).searchParams;
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > GATE_MAX_BYTES) {
		throw new HttpError(413, `the file is larger than ${Math.round(GATE_MAX_BYTES / 1024 / 1024)} MB`);
	}
	const expect = {
		width: positive(q.get("w"), "w"),
		height: positive(q.get("h"), "h"),
		fps: positive(q.get("fps"), "fps"),
		requireH264Aac: q.get("require_h264_aac") !== "0",
	};
	const name = safeName(q.get("name"), request.headers.get("content-type"));
	const dir = path.join(resolveGateDir(), randomUUID());
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	try {
		const bytes = await writeBody(request, file);
		if (bytes === 0) throw new HttpError(400, "the body is empty");
		const measures = await measureFile(file, name);
		const run = fileFindings(measures, expect, {
			commit: q.get("commit"),
		});
		return json({ measures, run, bytes }, 200, authHeaders(actor));
	} finally {
		if (!GATE_KEEP) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});
