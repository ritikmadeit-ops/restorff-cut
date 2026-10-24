/** Small helpers shared by the project-store route handlers. */
import { NextResponse } from "next/server";

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
		public extra?: Record<string, unknown>,
	) {
		super(message);
	}
}

export function json(body: unknown, status = 200, headers?: HeadersInit) {
	return NextResponse.json(body, { status, headers });
}

export async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new HttpError(400, "body must be JSON");
	}
}

/** Wraps a handler: HttpError → its status, anything else → 500 with the message logged. */
export function handle<A extends unknown[]>(
	fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
	return async (...args: A) => {
		try {
			return await fn(...args);
		} catch (error) {
			if (error instanceof HttpError) {
				return json({ error: error.message, ...(error.extra ?? {}) }, error.status);
			}
			console.error("[project-store]", error);
			const message = error instanceof Error ? error.message : "internal error";
			return json({ error: "internal error", detail: message }, 500);
		}
	};
}

export function str(value: unknown, field: string, opts: { optional?: boolean; max?: number } = {}): string | undefined {
	if (value === undefined || value === null || value === "") {
		if (opts.optional) return undefined;
		throw new HttpError(400, `${field} is required`);
	}
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	if (opts.max && value.length > opts.max) {
		throw new HttpError(400, `${field} is longer than ${opts.max} characters`);
	}
	return value;
}

export function num(value: unknown, field: string, opts: { optional?: boolean; min?: number } = {}): number | undefined {
	if (value === undefined || value === null) {
		if (opts.optional) return undefined;
		throw new HttpError(400, `${field} is required`);
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new HttpError(400, `${field} must be a finite number`);
	}
	if (opts.min !== undefined && value < opts.min) {
		throw new HttpError(400, `${field} must be >= ${opts.min}`);
	}
	return value;
}

export function iso(date: Date | string | null | undefined): string | null {
	if (!date) return null;
	const d = date instanceof Date ? date : new Date(date);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
