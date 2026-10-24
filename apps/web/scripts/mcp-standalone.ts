/**
 * RestorffCut's MCP endpoint on its own, without Next (security-pass agent, 2026-10-21). For a live test that needs
 * an env the shared dev server doesn't have (e.g. RESTORFFCUT_FETCH_ALLOW) without restarting that server, which
 * other sessions use. Serves POST /api/mcp only — src/mcp/handler.ts, the same code as the app's route — on
 * 127.0.0.1:<port>, on its OWN PGlite + media store under --dir (never the dev server's: PGlite is single-process),
 * and exits by itself after --lifetime seconds (default 300) or on GET /__quit, so nothing ever needs killing.
 *
 *   cd apps/web
 *   RESTORFFCUT_FETCH_ALLOW=127.0.0.1:8796 bun scripts/mcp-standalone.ts --port 8799 --dir <an empty folder>
 *   bun scripts/mcp-standalone.ts --port 8798 --dir <another empty folder>          (no allow-list: the default)
 *
 * Token: RESTORFFCUT_SERVICE_TOKEN (Bun loads apps/web/.env.local by itself; never printed). Works: timeline create,
 * media import (url / base64 / upload), styles, revise, transcribe. Doesn't: render, look and anything that needs the
 * Next app (the /render page in Chromium) — use the dev server for those. Used by
 * restorff/apps/gateway/scripts/security-pass-live.mjs.
 */
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : fallback;
};

const port = Number(arg("--port", "8799"));
const dir = arg("--dir");
const lifetimeS = Number(arg("--lifetime", "300"));
if (!dir) {
	console.error("--dir <folder> is required: this server keeps its own store there (never the dev server's).");
	process.exit(2);
}
if (!process.env.RESTORFFCUT_SERVICE_TOKEN) {
	console.error("RESTORFFCUT_SERVICE_TOKEN is not set (run from apps/web so Bun loads .env.local).");
	process.exit(2);
}
// before the store modules load: they read these once
process.env.RESTORFFCUT_DB = "pglite";
process.env.RESTORFFCUT_DATA_DIR = path.resolve(dir, "pglite");
process.env.RESTORFFCUT_MEDIA_DIR = path.resolve(dir, "media");
process.env.RESTORFFCUT_REFERENCES_DIR = path.resolve(dir, "references");

const { handleMcp } = await import("../src/mcp/handler");

Bun.serve({
	hostname: "127.0.0.1",
	port,
	idleTimeout: 255,
	fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === "/__quit") {
			setTimeout(() => process.exit(0), 50);
			return new Response("bye\n");
		}
		if (url.pathname === "/api/mcp") return handleMcp(request);
		return new Response("not found\n", { status: 404 });
	},
});
console.log(
	`RestorffCut MCP (standalone) on http://127.0.0.1:${port}/api/mcp · store ${path.resolve(dir)} · RESTORFFCUT_FETCH_ALLOW ${process.env.RESTORFFCUT_FETCH_ALLOW || "(off)"} · exits in ${lifetimeS} s`,
);
setTimeout(() => {
	console.log("lifetime over: exiting");
	process.exit(0);
}, lifetimeS * 1000);
