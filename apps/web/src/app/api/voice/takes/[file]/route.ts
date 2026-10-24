import { readFileSync } from "node:fs";
import { requireActor } from "@/server/auth";
import { handle, HttpError } from "@/server/http";
import { takeFilePath } from "@/server/voice";

type Ctx = { params: Promise<{ file: string }> };

/** GET /api/voice/takes/<key>.wav — a voice-over take (16-bit 48 kHz mono WAV), immutable: its key is its recipe. */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	await requireActor(request);
	const { file } = await ctx.params;
	const key = file.replace(/\.wav$/i, "");
	const path = takeFilePath(key);
	if (!path) throw new HttpError(404, `no voice take ${key}`);
	const bytes = readFileSync(path);
	return new Response(new Uint8Array(bytes), {
		status: 200,
		headers: {
			"Content-Type": "audio/wav",
			"Content-Length": String(bytes.byteLength),
			"Cache-Control": "private, max-age=31536000, immutable",
		},
	});
});
