import { handle, json } from "@/server/http";
import { receiveUpload } from "@/server/media-import";

type Ctx = { params: Promise<{ token: string }> };

/**
 * PUT /api/media-uploads/:token — the raw file as the body (mcp-media agent, 2026-10-20). The token comes from the MCP
 * call `media {action: "upload_url"}` and is the only credential (HMAC over upload id, timeline, expiry; 1 h).
 * 201 {upload_id, bytes, sha256}; then `media {action: "import", timeline_id, upload_id}` probes, stores and places it.
 * 404 unknown/bad token · 410 expired · 413 over RESTORFFCUT_IMPORT_MAX_MB.
 * Example: curl -sS -T clip.mp4 "http://localhost:8791/api/media-uploads/<token>"
 */
export const PUT = handle(async (request: Request, ctx: Ctx) => {
	const { token } = await ctx.params;
	const result = await receiveUpload(token, request);
	return json(
		{
			...result,
			next: { do: "Finish the import over MCP.", tool: "media", arguments: { action: "import", upload_id: result.upload_id } },
		},
		201,
	);
});

/** curl -T uses PUT; some clients only POST. Same handler. */
export const POST = PUT;
