/**
 * A fictional Halcyon Cold Brew scratch project on the running dev server that reproduces the timeline findings of
 * docs/restorff/QA-2026-10-20.md (#1 lane labels, #2 judge click empties the inspector, #10 stacked / duplicate
 * markers, #20 the JUDGE row over the first label) — ui-fix-timeline agent, 2026-10-21. Worklog:
 * docs/restorff/worklog/ui-fix-timeline.md.
 *
 * What it builds: eight lanes (TEXT · CAPTIONS · MOTION · V2 B-ROLL · V1 A-ROLL · MUSIC · SFX · VOICE) so the tracks
 * overflow the timeline panel at 1440×900 and scroll; four judge findings at 0:00 (as on the explainer recreation);
 * the same R5 finding twice (two ids, one pinned to a lane its element is NOT on, as the gate pinned the explainer's
 * "Type-on title"); an R15 must with a machine fix; one reviewer note.
 *
 * Media are ffmpeg `testsrc2` pictures + sine tones in the OS temp folder, uploaded to the project store. Nothing
 * leaves localhost.
 *
 *   cd apps/web
 *   bun scripts/timeline-fix-demo.ts        # prints {project, editor: http://localhost:8791/editor/<id>, ...}
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
const projectId = `uifix-timeline-${stamp}`;
const dir = join(tmpdir(), "restorffcut-uifix-timeline", stamp);
mkdirSync(dir, { recursive: true });

type MediaSpec = { ref: string; file: string; seconds: number; tone: number; amp: number; video: boolean };
const MEDIA: MediaSpec[] = [
	{ ref: "m01", file: "S01_pour.mp4", seconds: 5, tone: 220, amp: 0.2, video: true },
	{ ref: "m02", file: "S02_counter.mp4", seconds: 5, tone: 330, amp: 0.2, video: true },
	{ ref: "m03", file: "S03_glass.mp4", seconds: 5, tone: 440, amp: 0.2, video: true },
	{ ref: "m04", file: "S04_kettle.mp4", seconds: 3, tone: 660, amp: 0.08, video: true },
	{ ref: "m05", file: "type-on-title.mp4", seconds: 5, tone: 550, amp: 0.02, video: true },
	{ ref: "bed", file: "morning-bed.m4a", seconds: 13, tone: 196, amp: 0.06, video: false },
	{ ref: "vo", file: "vo-take1.m4a", seconds: 6, tone: 300, amp: 0.1, video: false },
	{ ref: "hit", file: "kettle-click.m4a", seconds: 1, tone: 1200, amp: 0.1, video: false },
];

function makeMedia(spec: MediaSpec): string {
	const out = join(dir, spec.file);
	const audio = ["-f", "lavfi", "-i", `sine=f=${spec.tone}:sample_rate=48000:duration=${spec.seconds}`];
	const video = spec.video ? ["-f", "lavfi", "-i", `testsrc2=s=540x960:r=30:d=${spec.seconds}`] : [];
	const audioIndex = spec.video ? 1 : 0;
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		...video,
		...audio,
		"-filter_complex", `[${audioIndex}:a]volume=${spec.amp},aformat=channel_layouts=stereo[a]`,
		...(spec.video ? ["-map", "0:v", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15"] : []),
		"-map", "[a]", "-c:a", "aac", "-b:a", "128k", "-shortest",
		out,
	]);
	return out;
}

function skeleton(): Project {
	const now = new Date().toISOString();
	return {
		metadata: {
			id: projectId,
			name: "Halcyon Cold Brew / UI-FIX timeline scratch",
			duration: 0,
			createdAt: now,
			updatedAt: now,
			restorff: { opsVersion: "ops@1", pending: [], media: [], brand: "Halcyon Cold Brew", ad: "UI-FIX" },
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{ id: "trk-text", name: "TEXT", type: "text", elements: [], hidden: false },
						{ id: "trk-captions", name: "CAPTIONS", type: "text", elements: [], hidden: false, restorff: { role: "caption" } },
						{ id: "trk-motion", name: "MOTION", type: "video", muted: false, hidden: false, elements: [] },
						{ id: "trk-broll", name: "V2 B-ROLL", type: "video", muted: false, hidden: false, elements: [] },
					],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] },
					audio: [
						{ id: "trk-music", name: "MUSIC", type: "audio", muted: false, elements: [] },
						{ id: "trk-sfx", name: "SFX", type: "audio", muted: false, elements: [], restorff: { role: "sfx" } },
						{ id: "trk-voice", name: "VOICE", type: "audio", muted: false, elements: [] },
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
	const caption = { font: "Archivo", size: 5, weight: "bold" as const, color: "#EDEBE6", y: 520 };
	const endCard = { font: "Archivo", size: 6, weight: "bold" as const, color: "#0C0C0E", bg: true, bg_color: "#EDEBE6", bg_radius: 24, y: 420 };
	const ops = [
		...MEDIA.map((m) => ({
			op: "import_media",
			author: "compiler",
			kind: m.video ? "video" : "audio",
			url: `media/${m.file}`,
			name: m.file,
			duration: m.seconds,
			...(m.video ? { width: 540, height: 960, fps: 30 } : {}),
			has_audio: true,
			ref: m.ref,
		})),
		{ op: "insert", author: "compiler", track: "main", t: 0, media: "m01", in: 0, out: 4, name: "S01 pour", ref: "s01" },
		{ op: "insert", author: "compiler", track: "main", t: 4, media: "m02", in: 0.5, out: 4.5, name: "S02 counter", ref: "s02" },
		{ op: "insert", author: "compiler", track: "main", t: 8, media: "m03", in: 0.5, out: 4.5, name: "S03 glass", ref: "s03" },
		{ op: "insert", author: "compiler", track: "trk-broll", t: 1.5, media: "m04", in: 0, out: 1.5, name: "S04 kettle", ref: "s04" },
		{ op: "insert", author: "compiler", track: "trk-motion", t: 5, media: "m05", in: 0, out: 4, name: "Type-on title", ref: "typeon" },
		{ op: "insert", author: "compiler", track: "trk-text", t: 0.2, text: "ONE POUR.", dur: 2, style: headline },
		{ op: "insert", author: "compiler", track: "trk-text", t: 10.5, text: "12 cups a bottle", dur: 1.5, style: endCard, ref: "endcard" },
		{ op: "insert", author: "compiler", track: "trk-captions", t: 0.5, text: "cold brew", dur: 1.2, style: caption },
		{ op: "insert", author: "compiler", track: "trk-captions", t: 1.8, text: "in one pour", dur: 1.4, style: caption },
		{ op: "insert", author: "compiler", track: "trk-music", t: 0, media: "bed", in: 0, out: 12, name: "morning-bed", ref: "bedEl" },
		{ op: "gain", author: "compiler", el: "bedEl", db: -16 },
		{ op: "insert", author: "compiler", track: "trk-sfx", t: 1.5, media: "hit", in: 0, out: 0.5, name: "kettle-click" },
		{ op: "insert", author: "compiler", track: "trk-voice", t: 0.5, media: "vo", in: 0, out: 6, name: "vo-take1" },
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
		const meta = {
			id: refs[m.ref],
			name: m.file,
			type: m.video ? "video" : "audio",
			size: bytes.length,
			lastModified: 0,
			duration: m.seconds,
			hasAudio: true,
			...(m.video ? { width: 540, height: 960, fps: 30 } : {}),
		};
		const res = await fetch(`${BASE}/api/projects/${projectId}/media/${refs[m.ref]}`, {
			method: "PUT",
			headers: {
				"Content-Type": m.video ? "video/mp4" : "audio/mp4",
				"X-Media-Meta": Buffer.from(JSON.stringify(meta)).toString("base64url"),
			},
			body: bytes,
		});
		if (res.status !== 201) throw new Error(`PUT media ${m.file} → ${res.status}`);
	}

	const gate = "gate:restorffcut@0.1.0";
	const findings = [
		// Four at 0:00, as the gate left them on the explainer recreation (QA #10).
		{ id: "uifix-R3-0", rule: "R3", severity: "should", status: "open", t: 0, t_end: 0.3, track: "TEXT", element_id: null, evidence: "TIMELINE", message: "No hook headline in the first 0.3 s.", fix: "add a headline (≤ 7 words) in by 0.3 s", source: gate },
		{ id: "uifix-R1-open", rule: "R1", severity: "should", status: "open", t: 0, t_end: 3, track: "V1 A-ROLL", element_id: refs.s01, evidence: "TIMELINE", message: "Only 1 shot in the first 3 s; the hook needs at least 3.", fix: "cut the first 3 s into 3 or more shots", source: gate },
		{ id: "uifix-R12-bed", rule: "R12", severity: "should", status: "open", t: 0, t_end: 12, track: "MUSIC", element_id: null, evidence: "TIMELINE", message: "The bed sits 16 dB under; check it reads under the voice.", fix: "listen at 0:00–0:12", source: gate },
		{ id: "uifix-R4-frame1", rule: "R4", severity: "should", status: "open", t: 0, t_end: null, track: "SFX", element_id: null, evidence: "TIMELINE", message: "Frame 1 has no sound hit.", fix: "start the hook on a hit at 0.0 s", source: gate },
		// The same R5 twice (two ids), pinned to V2 B-ROLL although "Type-on title" sits on MOTION (QA #2 + #10).
		{ id: "uifix-R5-a", rule: "R5", severity: "should", status: "open", t: 5, t_end: 9, track: "V2 B-ROLL", track_id: "trk-broll", element_id: refs.typeon, evidence: "TIMELINE", message: "\"Type-on title\" holds for 4.0 s.", fix: "cut \"Type-on title\" to 3 s or give it a move", source: gate },
		{ id: "uifix-R5-b", rule: "R5", severity: "should", status: "open", t: 5, t_end: 9, track: "V2 B-ROLL", track_id: "trk-broll", element_id: "el-replaced-type-on-title", evidence: "TIMELINE", message: "\"Type-on title\" holds for 4.0 s.", fix: "cut \"Type-on title\" to 3 s or give it a move", source: gate },
		{
			id: "uifix-R15-01", rule: "R15", severity: "must", status: "open", t: 10.5, t_end: 12, track: "TEXT",
			element_id: refs.endcard, evidence: "SEEN",
			message: "The offer lands at 0:10. It needs to be on screen by 0:09.",
			fix: "move the end card to 0:09",
			source: "judge:restorff-sell@1.0", judges: ["judge:restorff-sell@1.0", "judge:restorff-craft@1.0"],
			fix_ops: [{ op: "move", el: refs.endcard, t: 9 }],
		},
	];
	const posted = await call("POST", `/api/projects/${projectId}/comments`, { findings, commit_id: commitId });
	await call("POST", `/api/projects/${projectId}/comments`, {
		time_s: 2.1,
		body: "Can the headline stay a beat longer?",
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
				typeon: refs.typeon,
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
