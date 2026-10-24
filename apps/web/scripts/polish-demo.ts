/**
 * A fictional Halcyon Cold Brew / AD-014 project on the running dev server, for looking at the polish work in the
 * editor (docs/restorff/worklog/polish.md): the artboard's fixed lanes (CAPTIONS and SFX left EMPTY on purpose),
 * three A-roll clips with audio meeting under a dissolve and a whip (audio crossfades), a B-roll clip, a headline,
 * an end card, a music bed, and judge findings on the JUDGE row — one of them (R15) with a machine fix (`fix_ops`,
 * "Move the end card to 0:09") so the finding card shows Apply fix.
 *
 * Media are made here by ffmpeg (gradients + sine tones), written to the OS temp folder, uploaded to the project
 * store. Nothing leaves localhost.
 *
 *   cd apps/web
 *   bun scripts/polish-demo.ts                  # prints the editor URL: http://localhost:8791/editor/<id>
 *
 * Needs: the dev server on 8791 (local dev mode = no auth), ffmpeg on PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, EDITOR_PROJECT_VERSION, type Op, type Project } from "@restorffcut/timeline-ops";

const BASE = process.env.RESTORFFCUT_DEV_URL ?? "http://localhost:8791";
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const projectId = `polish-demo-${stamp}`;
const dir = join(tmpdir(), "restorffcut-polish-demo", stamp);
mkdirSync(dir, { recursive: true });

type MediaSpec = { ref: string; file: string; seconds: number; tones: number[]; amp: number; c0?: string; c1?: string };
const MEDIA: MediaSpec[] = [
	{ ref: "m01", file: "S01_morning.mp4", seconds: 5, tones: [220], amp: 0.2, c0: "0x2a1c12", c1: "0x9a6a3c" },
	{ ref: "m08", file: "S08_counter.mp4", seconds: 5, tones: [330], amp: 0.2, c0: "0x1d2b22", c1: "0x5f8a66" },
	{ ref: "m16", file: "S16_glass.mp4", seconds: 5, tones: [440], amp: 0.2, c0: "0x16222e", c1: "0x6d8fb0" },
	{ ref: "m03", file: "S03_kettle.mp4", seconds: 3, tones: [660], amp: 0.08, c0: "0x4a3526", c1: "0xc8553d" },
	{ ref: "bed", file: "morning-bed.m4a", seconds: 13, tones: [196, 247], amp: 0.06 },
];

function makeMedia(spec: MediaSpec): string {
	const out = join(dir, spec.file);
	const audioInputs = spec.tones.flatMap((f) => ["-f", "lavfi", "-i", `sine=f=${f}:sample_rate=48000:duration=${spec.seconds}`]);
	const isVideo = spec.file.endsWith(".mp4");
	const videoInput = isVideo
		? ["-f", "lavfi", "-i", `gradients=s=540x960:r=30:c0=${spec.c0}:c1=${spec.c1}:duration=${spec.seconds}:speed=0.015`]
		: [];
	const first = isVideo ? 1 : 0;
	const mix = spec.tones.map((_, i) => `[${first + i}:a]`).join("");
	const filter = `${mix}amix=inputs=${spec.tones.length}:normalize=0,volume=${spec.amp},aformat=channel_layouts=stereo[a]`;
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		...videoInput,
		...audioInputs,
		"-filter_complex", filter,
		...(isVideo ? ["-map", "0:v", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15"] : []),
		"-map", "[a]", "-c:a", "aac", "-b:a", "160k", "-shortest",
		out,
	]);
	return out;
}

/** The gateway's empty skeleton (restorff/apps/gateway/src/editor-skeleton.mjs): the artboard's six lanes. */
function skeleton(): Project {
	const now = new Date().toISOString();
	return {
		metadata: {
			id: projectId,
			name: "Halcyon Cold Brew / AD-014",
			duration: 0,
			createdAt: now,
			updatedAt: now,
			restorff: { opsVersion: "ops@1", pending: [], media: [], brand: "Halcyon Cold Brew", ad: "AD-014" },
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{ id: "trk-text", name: "TEXT", type: "text", elements: [], hidden: false },
						{ id: "trk-captions", name: "CAPTIONS", type: "text", elements: [], hidden: false },
						{ id: "trk-broll", name: "V2 B-ROLL", type: "video", muted: false, hidden: false, elements: [] },
					],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] },
					audio: [
						{ id: "trk-music", name: "MUSIC", type: "audio", muted: false, elements: [] },
						{ id: "trk-sfx", name: "SFX", type: "audio", muted: false, elements: [], restorff: { role: "sfx" } },
					],
				},
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene-main",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			canvasSizeMode: "preset",
			background: { type: "color", color: "#000000" },
		},
		version: EDITOR_PROJECT_VERSION,
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	} as unknown as Project;
}

async function call(method: string, route: string, body?: unknown) {
	const res = await fetch(`${BASE}${route}`, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const json = (await res.json().catch(() => null)) as any;
	if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${JSON.stringify(json).slice(0, 600)}`);
	return json;
}

async function main() {
	const files = new Map(MEDIA.map((m) => [m.ref, makeMedia(m)]));
	const headline = { font: "Archivo", size: 9, weight: "bold" as const, color: "#EDEBE6", uppercase: true, y: -560 };
	const endCard = { font: "Archivo", size: 6, weight: "bold" as const, color: "#0C0C0E", bg: true, bg_color: "#EDEBE6", bg_radius: 24, y: 420 };
	const ops = [
		...MEDIA.map((m) => ({
			op: "import_media",
			author: "compiler",
			kind: m.file.endsWith(".mp4") ? "video" : "audio",
			url: `media/${m.file}`,
			name: m.file,
			duration: m.seconds,
			...(m.file.endsWith(".mp4") ? { width: 540, height: 960, fps: 30 } : {}),
			has_audio: true,
			ref: m.ref,
		})),
		{ op: "insert", author: "compiler", track: "main", t: 0, media: "m01", in: 0, out: 4, name: "S01 morning", ref: "s01" },
		{ op: "insert", author: "compiler", track: "main", t: 4, media: "m08", in: 0.5, out: 4.5, name: "S08 counter", ref: "s08" },
		{ op: "insert", author: "compiler", track: "main", t: 8, media: "m16", in: 0.5, out: 4.5, name: "S16 glass", ref: "s16" },
		{ op: "transition", author: "compiler", a: "s01", b: "s08", kind: "dissolve", dur: 0.8 },
		{ op: "transition", author: "compiler", a: "s08", b: "s16", kind: "whip-left", dur: 0.5 },
		{ op: "insert", author: "compiler", track: "trk-broll", t: 1.5, media: "m03", in: 0, out: 1.5, name: "S03 kettle" },
		{ op: "insert", author: "compiler", track: "trk-text", t: 0.2, text: "ONE POUR.", dur: 2, style: headline },
		{ op: "insert", author: "compiler", track: "trk-text", t: 10.5, text: "12 cups a bottle", dur: 1.5, style: endCard, ref: "endcard" },
		{ op: "insert", author: "compiler", track: "trk-music", t: 0, media: "bed", in: 0, out: 12, name: "morning-bed", ref: "bedEl" },
		{ op: "gain", author: "compiler", el: "bedEl", db: -16 },
	] as unknown as Op[];

	const result = apply(skeleton(), ops, { seed: projectId, at: new Date().toISOString() });
	if (!result.ok) throw new Error(`ops refused: ${JSON.stringify(result.conflicts)}`);
	const refs = result.changes.refs;
	const project = result.project;
	project.metadata.duration = 12 * 120_000;

	const created = await call("POST", "/api/projects", {
		snapshot: project,
		author: "compiler",
		message: "compiler v0",
		ops: result.changes.applied,
	});
	const commitId: string = created.commit.id;

	for (const m of MEDIA) {
		const bytes = readFileSync(files.get(m.ref)!);
		const isVideo = m.file.endsWith(".mp4");
		const meta = {
			id: refs[m.ref],
			name: m.file,
			type: isVideo ? "video" : "audio",
			size: bytes.length,
			lastModified: 0,
			duration: m.seconds,
			hasAudio: true,
			...(isVideo ? { width: 540, height: 960, fps: 30 } : {}),
		};
		const res = await fetch(`${BASE}/api/projects/${projectId}/media/${refs[m.ref]}`, {
			method: "PUT",
			headers: {
				"Content-Type": isVideo ? "video/mp4" : "audio/mp4",
				"X-Media-Meta": Buffer.from(JSON.stringify(meta)).toString("base64url"),
			},
			body: bytes,
		});
		if (res.status !== 201) throw new Error(`PUT media ${m.file} → ${res.status}`);
	}

	const findings = [
		{
			id: "ad014-c3-R15-01", rule: "R15", severity: "must", status: "open", t: 10.5, t_end: 12, track: "TEXT",
			element_id: refs.endcard, evidence: "SEEN",
			message: "The offer lands at 0:10. It needs to be on screen by 0:09.",
			fix: "move the end card to 0:09",
			source: "judge:restorff-sell@1.0", judges: ["judge:restorff-sell@1.0", "judge:restorff-craft@1.0"],
			fix_ops: [{ op: "move", el: refs.endcard, t: 9 }],
		},
		{
			id: "ad014-c3-R5-01", rule: "R5", severity: "should", status: "open", t: 4, t_end: 8, track: "V1 A-ROLL",
			element_id: refs.s08, evidence: "READ",
			message: "S08 holds for 4.0 s.", fix: "cut S08 to 3.5 s or give it a move",
			source: "judge:restorff-craft@1.0",
		},
		{
			id: "ad014-c3-R18-01", rule: "R18", severity: "should", status: "open", t: 6.2, t_end: null, track: "TEXT",
			element_id: null, evidence: "SEEN",
			message: "A caption covers the bottle's label.", fix: "move the caption above the bottle",
			source: "judge:restorff-craft@1.0",
		},
		{
			id: "ad014-c3-LOUD-01", rule: "LOUD", severity: "info", status: "open", t: 0, t_end: null, track: "MASTER",
			element_id: null, evidence: "MEASURED",
			message: "−14.1 LUFS integrated, −1.2 dBTP: on target.", fix: "nothing to do",
			source: "worker:judge@0.1.0",
		},
	];
	const posted = await call("POST", `/api/projects/${projectId}/comments`, { findings, commit_id: commitId });
	await call("POST", `/api/projects/${projectId}/comments`, {
		time_s: 2.1,
		body: "Love the pour. Can the headline stay a beat longer?",
		author: "Mira (review link)",
	});

	console.log(
		JSON.stringify(
			{
				project: projectId,
				commit: commitId.slice(0, 7),
				media: MEDIA.length,
				findings: posted.comments.length,
				errors: posted.errors,
				endcard: refs.endcard,
				editor: `${BASE}/editor/${projectId}`,
				mediaDir: dir,
			},
			null,
			1,
		),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
