import { callService, errorResponse, ServiceError } from "../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RenderAnswer {
	name: string;
	hash: string;
	file: string;
	cached: boolean;
	duration: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	bytes: number;
	params: Record<string, unknown>;
	ms: number;
}

/**
 * POST /api/compositions/render  { name, props?, width?, height?, fps?, duration? }
 * → { name, hash, url, cached, duration, width, height, fps, frames, bytes, params, ms }
 * Renders to WebM VP9 with alpha (cached by the render's input hash) and returns where to fetch it.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body.name !== "string") {
			throw new ServiceError("body must be JSON with a composition name", 400);
		}
		const answer = await callService<RenderAnswer>({
			verb: "render",
			request: {
				name: body.name,
				props: body.props ?? {},
				width: body.width,
				height: body.height,
				fps: body.fps,
				duration: body.duration,
			},
		});
		// Never hand the server's file path to the page: the file is served by hash.
		const { file: _file, ...rest } = answer;
		return Response.json({ ...rest, url: `/api/compositions/file/${answer.hash}` });
	} catch (error) {
		return errorResponse(error);
	}
}
