/** Browser client for the /api/compositions routes (server side: app/api/compositions). */
import type {
	CompositionEntry,
	NudgeAnswer,
	ParamValues,
	RenderAnswer,
} from "./types";

let cataloguePromise: Promise<CompositionEntry[]> | null = null;

/**
 * A failed /api/compositions call with what the server said: `report.needs` lists the params a render still needs
 * (the compose dialog turns them into inline field errors instead of a raw toast — ui-fix-panels, QA #9).
 */
export class CompositionApiError extends Error {
	status: number;
	report: { needs?: string[]; [key: string]: unknown } | null;
	constructor(message: string, status: number, report: CompositionApiError["report"]) {
		super(message);
		this.name = "CompositionApiError";
		this.status = status;
		this.report = report;
	}
}

async function readJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as
		| (T & { error?: string; report?: CompositionApiError["report"] })
		| null;
	if (!response.ok || !body) {
		throw new CompositionApiError(body?.error ?? `request failed (${response.status})`, response.status, body?.report ?? null);
	}
	return body;
}

/** The composition library (cached for the page's life; pass `refresh` after adding compositions). */
export function fetchCatalogue({
	refresh = false,
}: {
	refresh?: boolean;
} = {}): Promise<CompositionEntry[]> {
	if (!cataloguePromise || refresh) {
		cataloguePromise = fetch("/api/compositions")
			.then((response) =>
				readJson<{ compositions: CompositionEntry[] }>(response),
			)
			.then((body) => body.compositions)
			.catch((error) => {
				cataloguePromise = null;
				throw error;
			});
	}
	return cataloguePromise;
}

export function sampleUrl({ name }: { name: string }): string {
	return `/api/compositions/sample/${name}`;
}

export async function renderComposition({
	name,
	props,
	width,
	height,
	fps,
	duration,
}: {
	name: string;
	props: ParamValues;
	width: number;
	height: number;
	fps: number;
	duration?: number;
}): Promise<RenderAnswer> {
	const response = await fetch("/api/compositions/render", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, props, width, height, fps, duration }),
	});
	return readJson<RenderAnswer>(response);
}

export async function nudgeComposition({
	name,
	props,
	sentence,
	source,
}: {
	name: string;
	props: ParamValues;
	sentence: string;
	/** A custom composition's HTML (its params block drives the nudge); omit for library compositions. */
	source?: string;
}): Promise<NudgeAnswer> {
	const response = await fetch("/api/compositions/nudge", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(source ? { source, props, sentence } : { name, props, sentence }),
	});
	return readJson<NudgeAnswer>(response);
}

/** Download a render as a File the editor's normal media import can take. */
export async function fetchRenderFile({
	answer,
	title,
}: {
	answer: RenderAnswer;
	title: string;
}): Promise<File> {
	const response = await fetch(answer.url);
	if (!response.ok) throw new Error(`could not fetch the render (${response.status})`);
	const blob = await response.blob();
	const safe = title.replace(/[^\w\- ·]+/g, "").trim() || answer.name;
	return new File([blob], `${safe} · ${answer.hash.slice(0, 6)}.webm`, {
		type: "video/webm",
	});
}
