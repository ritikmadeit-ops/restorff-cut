/** Serving renders made over MCP: the row, and the mastered MP4 (single `Range: bytes=a-b` honoured, for seeking). */
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { HttpError } from "./http";
import { freshRow, isRenderId, type RenderRow } from "./renders-store";

export function renderRowOr404(id: string): RenderRow {
	const row = isRenderId(id) ? freshRow(id) : null;
	if (!row) throw new HttpError(404, `render ${id} not found`);
	return row;
}

export function serveRenderFile(row: RenderRow, request: Request): Response {
	if (row.status !== "done" || !row.file) throw new HttpError(409, `render ${row.render_id} is ${row.status}`);
	if (!existsSync(row.file)) throw new HttpError(410, `render ${row.render_id} is recorded but its file is gone`);
	const total = statSync(row.file).size;
	const url = new URL(request.url);
	// ?download=1[&name=<file name>] → a download (the editor's "Download final", ui-fix-render 2026-10-21)
	const asked = (url.searchParams.get("name") ?? "").replace(/\.mp4$/i, "").replace(/[^A-Za-z0-9._ -]+/g, "-").trim().slice(0, 80);
	const name = `${asked || `${row.project_id}-${row.commit.slice(0, 7)}-${row.quality}`}.mp4`.replace(/[^A-Za-z0-9._ -]/g, "-");
	const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
	const headers: Record<string, string> = {
		"Content-Type": "video/mp4",
		"Accept-Ranges": "bytes",
		"Content-Disposition": `${disposition}; filename="${name}"`,
		"Cache-Control": "private, max-age=31536000, immutable",
	};
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		const start = Math.max(0, range[1] ? Number(range[1]) : total - Number(range[2]));
		const end = Math.min(total - 1, range[1] && range[2] ? Number(range[2]) : total - 1);
		if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
		const stream = Readable.toWeb(createReadStream(row.file, { start, end })) as unknown as ReadableStream;
		return new Response(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) } });
	}
	const stream = Readable.toWeb(createReadStream(row.file)) as unknown as ReadableStream;
	return new Response(stream, { status: 200, headers: { ...headers, "Content-Length": String(total) } });
}
