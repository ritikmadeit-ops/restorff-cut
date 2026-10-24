#!/usr/bin/env bun
// retention — measure a video file the way RestorffCut's gate does (agent retention, 2026-10-24): first visual change,
// every stretch with no visual change, events per 10 s (overall and per 10 s window), cuts per 10 s, % of cuts on a
// sound hit. The same measurer `check`, `look` and the `retention` MCP tool use (src/server/retention-measure.ts;
// the maths in packages/gate/src/retention.ts = tools/mcp-test/score.py's detectors).
//
//   cd apps/web && bun scripts/retention.ts <file.mp4> [--no-cache] [--events]
//
// stdout: JSON {file, ms, cached, probe, map} (map.events / map.cuts / map.stretches only with --events; counts always).
// Needs ffmpeg + ffprobe on PATH (or RESTORFFCUT_FFMPEG / RESTORFFCUT_FFPROBE). Exit 1 on an error, 2 on usage.
import { measureRetention } from "../src/server/retention-measure";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
	console.error("usage: bun scripts/retention.ts <file.mp4> [--no-cache] [--events]");
	process.exit(2);
}
try {
	const got = await measureRetention(file, { cache: !args.includes("--no-cache") });
	const { map } = got;
	const full = args.includes("--events");
	const out = {
		file,
		ms: got.ms,
		cached: got.cached,
		probe: got.probe,
		map: full
			? map
			: {
					...map,
					events: undefined,
					cuts: undefined,
					stretches: undefined,
					event_count: map.events.length,
					cut_count: map.cuts.length,
				},
	};
	console.log(JSON.stringify(out, null, 1));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
