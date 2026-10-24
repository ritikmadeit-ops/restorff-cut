import { NextResponse } from "next/server";
import { FREESOUND_NOT_CONFIGURED, freesoundConfigured } from "../config";

/** GET /api/sounds/status → which sound sources work right now (the built-in pack always does). */
export async function GET() {
	const freesound = freesoundConfigured();
	return NextResponse.json({
		builtin: true,
		freesound,
		message: freesound ? null : FREESOUND_NOT_CONFIGURED.message,
	});
}
