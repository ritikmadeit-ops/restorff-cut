/**
 * The command-history hook for EDT-20. Whoever turns a typed instruction into ops calls `recordInstruction` once per
 * sentence; the styles lab counts repeats from this history and offers "Save as style?".
 *
 * Wired in the bridge agent's command bar (apps/web/src/command-bar/command-bar.tsx, `submit`, one line right after
 * `resolveSentence`). The MCP path (Claude's own timeline_ops commits) is NOT recorded yet: integration item.
 *
 * Ops are stored compacted (the first op of each distinct shape): repeat detection and drafting only need shapes,
 * and a "tighter cut" can be 60 ops — this keeps localStorage small.
 */
import { opShape, type InstructionRecord } from "@restorffcut/styles";
import type { Op } from "@restorffcut/timeline-ops";
import { useStylesLabStore } from "./store";

type Listener = (record: InstructionRecord) => void;
const listeners = new Set<Listener>();

function compact(ops: readonly Op[]): Op[] {
	const seen = new Set<string>();
	const out: Op[] = [];
	for (const op of ops) {
		const shape = opShape(op);
		if (seen.has(shape)) continue;
		seen.add(shape);
		out.push(op);
	}
	return out;
}

export interface InstructionInput {
	sentence: string;
	ops: readonly Op[];
	/** timeline-ops IntentPlan.clauses (each has text + ops); optional. */
	clauses?: ReadonlyArray<{ text: string; ops: readonly Op[] }>;
	projectId?: string;
	/**
	 * Median caption size on the project before the sentence ran (@restorffcut/styles projectCaptionSize): a saved
	 * "bigger captions" then stores ×1.35, not an absolute size (ui-fix-panels, QA #8).
	 */
	captionSizeBefore?: number;
}

/** Record one instruction. Never throws (a broken history must not break the command bar). */
export function recordInstruction(input: InstructionInput): void {
	try {
		const sentence = input.sentence.trim();
		if (!sentence) return;
		const record: InstructionRecord = {
			sentence,
			ops: compact(input.ops ?? []),
			...(input.clauses?.length ? { clauses: input.clauses.map((clause) => ({ text: clause.text, ops: compact(clause.ops ?? []) })) } : {}),
			...(input.projectId ? { projectId: input.projectId } : {}),
			...(typeof input.captionSizeBefore === "number" && input.captionSizeBefore > 0 ? { caption_size_before: input.captionSizeBefore } : {}),
			at: new Date().toISOString(),
		};
		useStylesLabStore.getState().addRecord(record);
		for (const listener of listeners) {
			try {
				listener(record);
			} catch {
				// a listener's problem is its own
			}
		}
	} catch (error) {
		console.warn("styles-lab: could not record the instruction", error);
	}
}

/** Subscribe to recorded instructions; returns the unsubscribe function. */
export function onInstruction(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
