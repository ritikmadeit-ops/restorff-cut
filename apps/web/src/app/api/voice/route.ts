import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import { DEFAULT_VOICE, listVoices, synthesizeTake } from "@/server/voice";

/**
 * GET  /api/voice → the voices this machine can speak with (Windows' own engines; voice-music agent, 2026-10-20).
 * POST /api/voice {text, voice?, rate?} → make (or reuse) a take: {take: {key, url, duration_s, words, loudness,
 *      timing}}. Nothing goes on a timeline: the MCP `voiceover` tool does that as a commit.
 */
export const GET = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const { voices, error } = await listVoices();
	return json({ voices, default: DEFAULT_VOICE, ...(error ? { error } : {}) }, 200, authHeaders(actor));
});

export const POST = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const body = (await readJson(request)) as { text?: unknown; voice?: unknown; rate?: unknown };
	if (typeof body?.text !== "string") throw new HttpError(400, "text is required");
	const { take, cached } = await synthesizeTake(
		{ text: body.text, voice: typeof body.voice === "string" ? body.voice : undefined, speed: typeof body.rate === "number" ? body.rate : undefined },
		request.signal,
	);
	const { file: _file, ...rest } = take;
	return json({ take: { ...rest, url: `/api/voice/takes/${take.key}.wav`, cached } }, 201, authHeaders(actor));
});
