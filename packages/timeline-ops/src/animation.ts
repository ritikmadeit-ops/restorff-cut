/**
 * Keyframe maths, ported from apps/web/src/animation/{keyframes,interpolation,bezier,channel-data}.ts so a split,
 * trim or keyframe op leaves `element.animations` exactly as the editor's commands would (ids aside: the editor draws
 * random UUIDs, the reducer draws deterministic ones).
 */
import type {
	AnimationChannel,
	AnimationInterpolation,
	ChannelData,
	CompositeChannelData,
	DiscreteAnimationKey,
	DiscreteChannel,
	ElementAnimations,
	ScalarAnimationKey,
	ScalarChannel,
	ScalarSegmentType,
	Ticks,
} from "./model.ts";
import { roundHalfAwayFromZero } from "./time.ts";

export type NewId = (purpose: string) => string;

// ---------------------------------------------------------------- channel-data.ts

const LEGACY_STORAGE_KEYS = new Set(["bindings", "channels"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isLeafChannelData(data: ChannelData | undefined): data is AnimationChannel {
	return isRecord(data) && Array.isArray((data as { keys?: unknown }).keys);
}

export function isCompositeChannelData(data: ChannelData | undefined): data is CompositeChannelData {
	return isRecord(data) && !Array.isArray((data as { keys?: unknown }).keys);
}

function channelEntries(data: ChannelData | undefined): Array<[string, AnimationChannel | undefined]> {
	if (isLeafChannelData(data)) return [["value", data]];
	return isCompositeChannelData(data) ? Object.entries(data) : [];
}

function channelsOf(data: ChannelData | undefined): AnimationChannel[] {
	return channelEntries(data)
		.map(([, channel]) => channel)
		.filter((channel): channel is AnimationChannel => isLeafChannelData(channel));
}

function hasData(data: ChannelData | undefined): boolean {
	return channelsOf(data).some((channel) => channel.keys.length > 0);
}

/** keyframes.ts toAnimation: drop empty paths; `undefined` when nothing is left. */
export function compactAnimations(animations: ElementAnimations): ElementAnimations | undefined {
	const next = Object.fromEntries(
		Object.entries(animations).filter(([key, data]) => !LEGACY_STORAGE_KEYS.has(key) && hasData(data)),
	);
	return Object.keys(next).length === 0 ? undefined : next;
}

function setChannelInData(
	data: ChannelData | undefined,
	componentKey: string,
	channel: AnimationChannel | undefined,
): ChannelData | undefined {
	if (componentKey === "value") return channel;
	const components: CompositeChannelData = isCompositeChannelData(data) ? { ...data } : {};
	if (channel && channel.keys.length > 0) {
		components[componentKey] = channel;
	} else {
		delete components[componentKey];
	}
	return Object.keys(components).length > 0 ? components : undefined;
}

// ---------------------------------------------------------------- interpolation.ts

export function isScalarChannel(channel: AnimationChannel): channel is ScalarChannel {
	return (
		"extrapolation" in channel ||
		(channel.keys as Array<object>).some((key) => "segmentToNext" in key)
	);
}

function normalizeScalarKey(key: ScalarAnimationKey): ScalarAnimationKey {
	return { ...key, tangentMode: key.tangentMode ?? "flat", segmentToNext: key.segmentToNext ?? "linear" };
}

export function normalizeScalarChannel(channel: ScalarChannel): ScalarChannel {
	const sorted = [...channel.keys].map(normalizeScalarKey).sort((a, b) => a.time - b.time);
	const keys = sorted.map((key, index) => {
		const previous = sorted[index - 1];
		const next = sorted[index + 1];
		let leftHandle: ScalarAnimationKey["leftHandle"];
		if (previous != null && key.leftHandle) {
			const span = Math.max(1, key.time - previous.time);
			leftHandle = { dt: Math.max(-span, Math.min(0, key.leftHandle.dt)), dv: key.leftHandle.dv };
		}
		let rightHandle: ScalarAnimationKey["rightHandle"];
		if (next != null && key.rightHandle) {
			const span = Math.max(1, next.time - key.time);
			rightHandle = { dt: Math.min(span, Math.max(0, key.rightHandle.dt)), dv: key.rightHandle.dv };
		}
		const result: ScalarAnimationKey = { ...key, leftHandle, rightHandle };
		if (result.leftHandle === undefined) delete result.leftHandle;
		if (result.rightHandle === undefined) delete result.rightHandle;
		return result;
	});
	const result: ScalarChannel = { ...channel, keys };
	if (result.extrapolation === undefined) delete result.extrapolation;
	return result;
}

export function normalizeDiscreteChannel(channel: DiscreteChannel): DiscreteChannel {
	return { ...channel, keys: [...channel.keys].sort((a, b) => a.time - b.time) };
}

function normalizeChannel(channel: AnimationChannel): AnimationChannel {
	return isScalarChannel(channel) ? normalizeScalarChannel(channel) : normalizeDiscreteChannel(channel as DiscreteChannel);
}

// bezier.ts
function bezierPoint(progress: number, p0: number, p1: number, p2: number, p3: number): number {
	const mt = 1 - progress;
	return mt * mt * mt * p0 + 3 * mt * mt * progress * p1 + 3 * mt * progress * progress * p2 + progress ** 3 * p3;
}

function defaultRightHandle(leftKey: ScalarAnimationKey, rightKey: ScalarAnimationKey) {
	return { dt: (rightKey.time - leftKey.time) / 3, dv: (rightKey.value - leftKey.value) / 3 };
}

function defaultLeftHandle(leftKey: ScalarAnimationKey, rightKey: ScalarAnimationKey) {
	return { dt: -(rightKey.time - leftKey.time) / 3, dv: -(rightKey.value - leftKey.value) / 3 };
}

function solveBezierProgressForTime(time: number, leftKey: ScalarAnimationKey, rightKey: ScalarAnimationKey): number {
	let lower = 0;
	let upper = 1;
	const rightHandle = leftKey.rightHandle ?? defaultRightHandle(leftKey, rightKey);
	const leftHandle = rightKey.leftHandle ?? defaultLeftHandle(leftKey, rightKey);
	for (let iteration = 0; iteration < 20; iteration++) {
		const mid = (lower + upper) / 2;
		const estimate = bezierPoint(
			mid,
			leftKey.time,
			leftKey.time + rightHandle.dt,
			rightKey.time + leftHandle.dt,
			rightKey.time,
		);
		if (estimate < time) lower = mid;
		else upper = mid;
	}
	return (lower + upper) / 2;
}

export function scalarValueAt(channel: ScalarChannel | undefined, time: number, fallback: number): number {
	if (!channel || channel.keys.length === 0) return fallback;
	const normalized = normalizeScalarChannel(channel);
	const keys = normalized.keys;
	const first = keys[0];
	const last = keys[keys.length - 1];
	const extrapolate = (mode: "hold" | "linear", edge: ScalarAnimationKey, neighbor: ScalarAnimationKey | undefined) => {
		if (mode === "hold" || !neighbor) return edge.value;
		const span = neighbor.time - edge.time;
		if (span === 0) return edge.value;
		return edge.value + ((time - edge.time) / span) * (neighbor.value - edge.value);
	};
	if (time <= first.time) {
		return time < first.time ? extrapolate(normalized.extrapolation?.before ?? "hold", first, keys[1]) : first.value;
	}
	if (time >= last.time) {
		return time > last.time
			? extrapolate(normalized.extrapolation?.after ?? "hold", last, keys[keys.length - 2])
			: last.value;
	}
	for (let i = 0; i < keys.length - 1; i++) {
		const left = keys[i];
		const right = keys[i + 1];
		if (time === right.time) return right.value;
		if (!(time >= left.time && time <= right.time)) continue;
		if (left.segmentToNext === "step") return left.value;
		const span = right.time - left.time;
		if (span === 0) return right.value;
		const progress = Math.max(0, Math.min(1, (time - left.time) / span));
		if (left.segmentToNext === "linear") return left.value + (right.value - left.value) * progress;
		const curveProgress = solveBezierProgressForTime(time, left, right);
		const rightHandle = left.rightHandle ?? defaultRightHandle(left, right);
		const leftHandle = right.leftHandle ?? defaultLeftHandle(left, right);
		return bezierPoint(curveProgress, left.value, left.value + rightHandle.dv, right.value + leftHandle.dv, right.value);
	}
	return last.value;
}

function discreteValueAt(channel: DiscreteChannel, time: number, fallback: string | boolean): string | boolean {
	let current = fallback;
	for (const key of normalizeDiscreteChannel(channel).keys) {
		if (time < key.time) break;
		current = key.value;
	}
	return current;
}

// ---------------------------------------------------------------- keyframes.ts (upsert)

export function segmentTypeFor(interpolation: AnimationInterpolation): ScalarSegmentType {
	if (interpolation === "hold") return "step";
	return interpolation === "bezier" ? "bezier" : "linear";
}

function createScalarKey(
	id: string,
	time: Ticks,
	value: number,
	interpolation: AnimationInterpolation | undefined,
	previousKey?: ScalarAnimationKey,
): ScalarAnimationKey {
	const key: ScalarAnimationKey = {
		id,
		time,
		value,
		leftHandle: previousKey?.leftHandle,
		rightHandle: previousKey?.rightHandle,
		segmentToNext: previousKey?.segmentToNext ?? segmentTypeFor(interpolation ?? "linear"),
		tangentMode: previousKey?.tangentMode ?? "flat",
	};
	if (key.leftHandle === undefined) delete key.leftHandle;
	if (key.rightHandle === undefined) delete key.rightHandle;
	return key;
}

/**
 * keyframes.ts upsertScalarChannelKey + upsertPathKeyframe for a leaf numeric param (componentKey "value"):
 * a key at the same tick is updated in place (keeping its id), otherwise a new key is added.
 */
export function upsertScalarKeyframe(
	animations: ElementAnimations | undefined,
	propertyPath: string,
	time: Ticks,
	value: number,
	interpolation: AnimationInterpolation | undefined,
	newId: NewId,
): { animations: ElementAnimations | undefined; keyId: string; replaced: boolean } {
	const data = animations?.[propertyPath];
	const current = isLeafChannelData(data) && isScalarChannel(data) ? data : undefined;
	const normalized = normalizeScalarChannel(current ?? { keys: [] });
	const keys = [...normalized.keys];
	const existingIndex = keys.findIndex((key) => key.time === time);
	let keyId: string;
	let replaced = false;
	if (existingIndex >= 0) {
		const existing = keys[existingIndex];
		keyId = existing.id;
		replaced = true;
		keys[existingIndex] = createScalarKey(
			existing.id,
			existing.time,
			value,
			interpolation,
			interpolation != null ? { ...existing, segmentToNext: segmentTypeFor(interpolation) } : existing,
		);
	} else {
		keyId = newId("keyframe");
		keys.push(createScalarKey(keyId, time, value, interpolation ?? "linear"));
	}
	const channel = normalizeScalarChannel({ keys, extrapolation: normalized.extrapolation });
	const next: ElementAnimations = { ...(animations ?? {}), [propertyPath]: channel };
	return { animations: compactAnimations(next), keyId, replaced };
}

/** Replace a whole numeric channel (used by `duck`, which writes a complete volume envelope). */
export function setScalarChannel(
	animations: ElementAnimations | undefined,
	propertyPath: string,
	keys: ScalarAnimationKey[],
): ElementAnimations | undefined {
	const next: ElementAnimations = { ...(animations ?? {}) };
	if (keys.length === 0) delete next[propertyPath];
	else next[propertyPath] = normalizeScalarChannel({ keys });
	return compactAnimations(next);
}

// ---------------------------------------------------------------- keyframes.ts (split / clamp)

function lerpPoint(left: { x: number; y: number }, right: { x: number; y: number }, progress: number) {
	return { x: left.x + (right.x - left.x) * progress, y: left.y + (right.y - left.y) * progress };
}

function splitDiscreteChannel(
	channel: DiscreteChannel,
	splitTime: Ticks,
	leftBoundaryId: string,
	rightBoundaryId: string,
) {
	if (channel.keys.length === 0) return { left: undefined, right: undefined };
	const normalized = normalizeDiscreteChannel(channel);
	let leftKeys: DiscreteAnimationKey[] = normalized.keys.filter((key) => key.time <= splitTime);
	let rightKeys: DiscreteAnimationKey[] = normalized.keys
		.filter((key) => key.time >= splitTime)
		.map((key) => ({ ...key, time: key.time - splitTime }));
	const boundaryValue = discreteValueAt(normalized, splitTime, normalized.keys[0].value);
	if (!leftKeys.some((key) => key.time === splitTime)) {
		leftKeys = [...leftKeys, { id: leftBoundaryId, time: splitTime, value: boundaryValue }];
	}
	if (!rightKeys.some((key) => key.time === 0)) {
		rightKeys = [{ id: rightBoundaryId, time: 0, value: boundaryValue }, ...rightKeys];
	}
	return {
		left: leftKeys.length ? normalizeDiscreteChannel({ keys: leftKeys }) : undefined,
		right: rightKeys.length ? normalizeDiscreteChannel({ keys: rightKeys }) : undefined,
	};
}

function splitScalarChannel(channel: ScalarChannel, splitTime: Ticks, leftBoundaryId: string, rightBoundaryId: string) {
	if (channel.keys.length === 0) return { left: undefined, right: undefined };
	const normalized = normalizeScalarChannel(channel);
	const extrapolation = normalized.extrapolation;
	const wrap = (keys: ScalarAnimationKey[]): ScalarChannel | undefined => {
		if (!keys.length) return undefined;
		return normalizeScalarChannel(extrapolation ? { keys, extrapolation } : { keys });
	};
	let leftKeys = normalized.keys.filter((key) => key.time <= splitTime);
	let rightKeys = normalized.keys
		.filter((key) => key.time >= splitTime)
		.map((key) => ({ ...key, time: key.time - splitTime }));
	const hasLeftBoundary = leftKeys.some((key) => key.time === splitTime);
	const hasRightBoundary = rightKeys.some((key) => key.time === 0);
	if (hasLeftBoundary && hasRightBoundary) return { left: wrap(leftKeys), right: wrap(rightKeys) };

	for (let i = 0; i < normalized.keys.length - 1; i++) {
		const leftKey = normalized.keys[i];
		const rightKey = normalized.keys[i + 1];
		if (!(splitTime > leftKey.time && splitTime < rightKey.time)) continue;
		const boundaryValue = scalarValueAt(normalized, splitTime, leftKey.value);
		if (leftKey.segmentToNext === "bezier") {
			const rightHandle = leftKey.rightHandle ?? defaultRightHandle(leftKey, rightKey);
			const leftHandle = rightKey.leftHandle ?? defaultLeftHandle(leftKey, rightKey);
			const progress = solveBezierProgressForTime(splitTime, leftKey, rightKey);
			const p0 = { x: leftKey.time, y: leftKey.value };
			const p1 = { x: leftKey.time + rightHandle.dt, y: leftKey.value + rightHandle.dv };
			const p2 = { x: rightKey.time + leftHandle.dt, y: rightKey.value + leftHandle.dv };
			const p3 = { x: rightKey.time, y: rightKey.value };
			const q0 = lerpPoint(p0, p1, progress);
			const q1 = lerpPoint(p1, p2, progress);
			const q2 = lerpPoint(p2, p3, progress);
			const r0 = lerpPoint(q0, q1, progress);
			const r1 = lerpPoint(q1, q2, progress);
			const splitPoint = lerpPoint(r0, r1, progress);
			leftKeys = [
				...normalized.keys.filter((key) => key.time < splitTime && key.id !== leftKey.id),
				{ ...leftKey, rightHandle: { dt: roundHalfAwayFromZero(q0.x - p0.x), dv: q0.y - p0.y } },
				{
					id: leftBoundaryId,
					time: splitTime,
					value: boundaryValue,
					leftHandle: { dt: roundHalfAwayFromZero(r0.x - splitPoint.x), dv: r0.y - splitPoint.y },
					segmentToNext: leftKey.segmentToNext,
					tangentMode: leftKey.tangentMode,
				},
			];
			rightKeys = [
				{
					id: rightBoundaryId,
					time: 0,
					value: boundaryValue,
					rightHandle: { dt: roundHalfAwayFromZero(r1.x - splitPoint.x), dv: r1.y - splitPoint.y },
					segmentToNext: "bezier",
					tangentMode: leftKey.tangentMode,
				},
				{
					...rightKey,
					time: rightKey.time - splitTime,
					leftHandle: { dt: roundHalfAwayFromZero(q2.x - p3.x), dv: q2.y - p3.y },
				},
				...normalized.keys
					.filter((key) => key.time > rightKey.time)
					.map((key) => ({ ...key, time: key.time - splitTime })),
			];
		} else {
			leftKeys = [...leftKeys, createScalarKey(leftBoundaryId, splitTime, boundaryValue, "linear")];
			rightKeys = [
				createScalarKey(
					rightBoundaryId,
					0,
					boundaryValue,
					leftKey.segmentToNext === "step" ? "hold" : leftKey.segmentToNext,
				),
				...rightKeys,
			];
		}
		return { left: wrap(leftKeys), right: wrap(rightKeys) };
	}
	// DIVERGENCE (PARITY.md D3): the editor stops here, so a split after the last key leaves the right half with no
	// keys (and a split before the first key leaves the left half with none): that half falls back to the static
	// param value and the picture jumps at the cut. Hold the animated value instead.
	const first = normalized.keys[0];
	const last = normalized.keys[normalized.keys.length - 1];
	if (splitTime > last.time && !rightKeys.length) {
		const value = scalarValueAt(normalized, splitTime, last.value);
		rightKeys = [createScalarKey(rightBoundaryId, 0, value, last.segmentToNext === "step" ? "hold" : "linear")];
	}
	if (splitTime < first.time && !leftKeys.length) {
		const value = scalarValueAt(normalized, splitTime, first.value);
		leftKeys = [createScalarKey(leftBoundaryId, splitTime, value, "linear")];
	}
	return { left: wrap(leftKeys), right: wrap(rightKeys) };
}

/**
 * keyframes.ts:1231 splitAnimationsAtTime with shouldIncludeSplitBoundary = true (the only way the commands call it).
 * `splitTime` is element-relative. Right-side times are rebased to 0.
 */
export function splitAnimationsAtTime(
	animations: ElementAnimations | undefined,
	splitTime: Ticks,
	newId: NewId,
): { left: ElementAnimations | undefined; right: ElementAnimations | undefined } {
	if (!animations) return { left: undefined, right: undefined };
	const left: ElementAnimations = {};
	const right: ElementAnimations = {};
	for (const [path, data] of Object.entries(animations)) {
		if (LEGACY_STORAGE_KEYS.has(path) || !data) continue;
		const leftBoundaryId = newId(`split-left:${path}`);
		const rightBoundaryId = newId(`split-right:${path}`);
		for (const [componentKey, channel] of channelEntries(data)) {
			if (!channel) continue;
			const result = isScalarChannel(channel)
				? splitScalarChannel(channel, splitTime, leftBoundaryId, rightBoundaryId)
				: splitDiscreteChannel(channel as DiscreteChannel, splitTime, leftBoundaryId, rightBoundaryId);
			if (result.left) left[path] = setChannelInData(left[path], componentKey, result.left);
			if (result.right) right[path] = setChannelInData(right[path], componentKey, result.right);
		}
	}
	return { left: compactAnimations(left), right: compactAnimations(right) };
}

/** keyframes.ts:887 clampAnimationsToDuration (the update pipeline runs it whenever `duration` changes). */
export function clampAnimationsToDuration(
	animations: ElementAnimations | undefined,
	duration: Ticks,
	newId: NewId,
): ElementAnimations | undefined {
	if (!animations || duration <= 0) return undefined;
	return splitAnimationsAtTime(animations, duration, newId).left;
}

/** Every key time in every channel (for invariant checks). */
export function allKeyTimes(animations: ElementAnimations | undefined): number[] {
	if (!animations) return [];
	const times: number[] = [];
	for (const data of Object.values(animations)) {
		for (const channel of channelsOf(data)) {
			for (const key of channel.keys) times.push(key.time);
		}
	}
	return times;
}

export function normalizeAnyChannel(channel: AnimationChannel): AnimationChannel {
	return normalizeChannel(channel);
}
