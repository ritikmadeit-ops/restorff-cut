import { apply, type ApplyOptions, type Op, type Project, type TimelineElement, type TimelineTrack } from "../src/index.ts";
import { fixtureProject } from "./fixture.ts";

export function run(ops: Op[], options: Partial<ApplyOptions> = {}, project: Project = fixtureProject()) {
	return apply(project, ops, { seed: "test", ...options });
}

export function scene(project: Project) {
	return project.scenes[0];
}

export function allTracks(project: Project): TimelineTrack[] {
	const tracks = scene(project).tracks;
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

export function track(project: Project, id: string): TimelineTrack {
	const found = allTracks(project).find((candidate) => candidate.id === id);
	if (!found) throw new Error(`no track ${id}`);
	return found;
}

export function el(project: Project, id: string): TimelineElement {
	for (const candidate of allTracks(project)) {
		const found = candidate.elements.find((element) => element.id === id);
		if (found) return found;
	}
	throw new Error(`no element ${id}`);
}

export function trackOf(project: Project, id: string): TimelineTrack {
	const found = allTracks(project).find((candidate) => candidate.elements.some((element) => element.id === id));
	if (!found) throw new Error(`no element ${id}`);
	return found;
}

/** Element without the fields a split/trim comparison should ignore. */
export function shape(element: TimelineElement) {
	const { id: _id, name: _name, restorff: _restorff, animations, ...rest } = element;
	return { ...rest, animations: stripKeyIds(animations) };
}

export function stripKeyIds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripKeyIds);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "id")
				.map(([key, entry]) => [key, stripKeyIds(entry)]),
		);
	}
	return value;
}
