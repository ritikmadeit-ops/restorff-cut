"use client";

/**
 * The inspector's Grade row (design/edit-artboard.png: "Grade · warm morning") and its picker (grade agent,
 * 2026-10-20). The row prints the selected clip's look; clicking it opens:
 *   - scope pills: "This clip" (its own restorff-grade effect) / "Whole video" (the GRADE adjustment layer)
 *   - the named looks (packages/timeline-ops/src/grades.ts), "custom" and "none"
 *   - nudges: warmer · cooler · brighter · darker · more / less contrast
 *   - every slider of the grade, live while dragging, one undo step on release
 * Looks, nudges and "none" go through ops@1 (`grade`, the same reducer Claude and the styles use) as one undoable
 * command; sliders use the editor's preview → commit path like the Effects tab. Skin: BUILD-BRIEF §3 tokens.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import {
	GRADE_LOOKS,
	GRADE_NUDGES,
	GRADE_PARAM_SPECS,
	type GradeOp,
	type GradeParamGroup,
	type GradeParamSpec,
	matchLook,
	readGradeParams,
} from "@restorffcut/timeline-ops";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { useEditor } from "@/editor/use-editor";
import type { Effect } from "@/effects/types";
import { runOps } from "@/styles-lab/editor-bridge";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { cn } from "@/utils/ui";
import { clipGrade, gradeRowValue, type GradeScope, type GradeSource, isGradeLayer, timelineGrade } from "./target";

const GROUPS: Array<{ id: GradeParamGroup; label: string }> = [
	{ id: "light", label: "Light" },
	{ id: "colour", label: "Colour" },
	{ id: "tone", label: "Tone" },
	{ id: "split", label: "Split tone" },
	{ id: "texture", label: "Texture" },
	{ id: "strength", label: "Strength" },
];

const QUICK_NUDGES = ["warmer", "cooler", "brighter", "darker", "more-contrast", "less-contrast"];

function formatValue(spec: GradeParamSpec, value: number): string {
	if (spec.key === "exposure") return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)} EV`;
	if (spec.key === "shadowHue" || spec.key === "highlightHue") return `${Math.round(value)}°`;
	const rounded = Math.round(value);
	if (spec.min < 0) return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}`;
	return `${rounded}`;
}

/** The dd of the Grade row: the look name as a button that opens the picker. */
export function GradeRowValue({ element, track }: { element: TimelineElement; track: TimelineTrack }) {
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const [open, setOpen] = useState(false);
	if (!scene) return <dd className="text-fog m-0">—</dd>;
	const value = gradeRowValue(scene.tracks, element, track);
	return (
		<dd className="m-0 min-w-0">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						title="Change the grade"
						className={cn(
							"-mx-1.5 -my-0.5 flex max-w-full cursor-pointer items-center gap-1 rounded-[8px] px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--rc-raised)]",
							value.graded ? "text-bone" : "text-fog",
						)}
					>
						<span className="truncate">{value.text}</span>
						<HugeiconsIcon
							icon={ArrowDown01Icon}
							className={cn("text-fog size-3.5 shrink-0 transition-transform", open && "rotate-180")}
						/>
					</button>
				</PopoverTrigger>
				<PopoverContent align="end" side="left" className="bg-card w-[340px] rounded-[16px] p-0">
					<GradePicker element={element} track={track} />
				</PopoverContent>
			</Popover>
		</dd>
	);
}

function GradePicker({ element, track }: { element: TimelineElement; track: TimelineTrack }) {
	const editor = useEditor();
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	// re-render while a slider previews
	useEditor((e) => e.timeline.getPreviewTracks());
	const layerSelected = isGradeLayer(element);
	const canGradeClip = !layerSelected && ["video", "image", "text", "sticker", "graphic"].includes(element.type);
	const own = clipGrade(element, track);
	const layer = scene ? timelineGrade(scene.tracks, layerSelected ? undefined : element, layerSelected ? undefined : track) : null;
	const [scope, setScope] = useState<GradeScope>(own?.scope === "clip" || (!layer && canGradeClip) ? "clip" : "timeline");
	const source: GradeSource | null = layerSelected ? own : scope === "clip" ? own : layer;
	const target = layerSelected ? element.id : scope === "clip" ? element.id : "all";

	// live values: the preview overlay when a slider is being dragged, else the committed ones
	const previewTracks = editor.timeline.getPreviewTracks();
	const liveParams = useMemo(() => {
		if (!source) return null;
		const tracks = previewTracks ?? scene?.tracks;
		const all = tracks ? [...tracks.overlay, tracks.main, ...tracks.audio] : [];
		const holder = all.find((candidate) => candidate.id === source.trackId)?.elements.find((candidate) => candidate.id === source.elementId);
		if (!holder) return source.params;
		if (source.scope === "timeline") return holder.params;
		const effect = (holder as TimelineElement & { effects?: Effect[] }).effects?.find((candidate) => candidate.id === source.effectId);
		return effect?.params ?? source.params;
	}, [previewTracks, scene, source]);
	const params = readGradeParams(liveParams ?? undefined);
	const activeLook = liveParams ? (matchLook(params)?.id ?? (typeof liveParams.look === "string" ? liveParams.look : null)) : null;

	const run = (op: Omit<GradeOp, "author" | "op">, what: string) => {
		const grade: GradeOp = { op: "grade", author: "user", ...op };
		const report = runOps({
			editor,
			ops: [grade],
			seed: `${editor.project.getActive().metadata.id}/grade/${Date.now()}`,
		});
		if (report.skipped.length) toast.error(`Couldn't ${what}`, { description: report.skipped.join(" · ") });
		else if (!report.committed) toast.message(report.result.changes.ops[0]?.summary ?? `Nothing to ${what}`);
	};

	const previewParam = (key: string, value: number) => {
		if (!source || !liveParams) return;
		const nextParams = { ...liveParams, [key]: value };
		if (source.scope === "timeline") {
			editor.timeline.previewElements({ updates: [{ trackId: source.trackId, elementId: source.elementId, updates: { params: nextParams } as Partial<TimelineElement> }] });
			return;
		}
		const tracks = editor.timeline.getPreviewTracks() ?? editor.scenes.getActiveScene().tracks;
		const holder = [...tracks.overlay, tracks.main]
			.find((candidate) => candidate.id === source.trackId)
			?.elements.find((candidate) => candidate.id === source.elementId) as (TimelineElement & { effects?: Effect[] }) | undefined;
		const effects = (holder?.effects ?? []).map((effect) => (effect.id === source.effectId ? { ...effect, params: nextParams } : effect));
		editor.timeline.previewElements({ updates: [{ trackId: source.trackId, elementId: source.elementId, updates: { effects } as Partial<TimelineElement> }] });
	};

	return (
		<div className="flex max-h-[min(640px,80vh)] flex-col">
			<div className="flex items-center justify-between gap-3 border-b px-4 pt-3.5 pb-3">
				<h3 className="rc-label">Grade</h3>
				{!layerSelected && (
					<div className="flex gap-1" role="radiogroup" aria-label="Grade what">
						{(
							[
								{ id: "clip", label: "This clip", disabled: !canGradeClip },
								{ id: "timeline", label: "Whole video", disabled: false },
							] as const
						).map((option) => (
							<button
								key={option.id}
								type="button"
								role="radio"
								aria-checked={scope === option.id}
								disabled={option.disabled}
								onClick={() => setScope(option.id)}
								className={cn(
									"cursor-pointer rounded-full border px-2.5 py-1 text-[12px] transition-colors disabled:cursor-default disabled:opacity-40",
									scope === option.id ? "border-[var(--rc-outline)] bg-[var(--rc-raised)] text-bone" : "text-fog hover:text-bone",
								)}
							>
								{option.label}
							</button>
						))}
					</div>
				)}
			</div>

			<div className="flex-1 overflow-y-auto px-4 py-3">
				<div className="grid grid-cols-2 gap-1.5">
					{GRADE_LOOKS.map((look) => (
						<button
							key={look.id}
							type="button"
							title={look.hint}
							onClick={() => run({ target, preset: look.id }, `apply ${look.label}`)}
							className={cn(
								"flex cursor-pointer flex-col items-start gap-0.5 rounded-[12px] border px-2.5 py-2 text-left transition-colors hover:bg-[var(--rc-raised)]",
								activeLook === look.id ? "border-bone" : "border-[var(--rc-line)]",
							)}
						>
							<span className="text-[13px] font-medium text-bone">{look.label}</span>
							<span className="text-fog line-clamp-2 text-[11px] leading-snug">{look.hint}</span>
						</button>
					))}
				</div>
				<div className="mt-2 flex gap-1.5">
					<button
						type="button"
						disabled={!!source}
						title="A neutral grade to build with the sliders"
						onClick={() => run({ target, params: { amount: 100 } }, "start a custom grade")}
						className="text-fog flex-1 cursor-pointer rounded-full border border-[var(--rc-line)] px-2.5 py-1 text-[12px] hover:text-bone disabled:cursor-default disabled:opacity-40"
					>
						custom
					</button>
					<button
						type="button"
						disabled={!source}
						onClick={() => run({ target, preset: "none" }, "remove the grade")}
						className="text-fog flex-1 cursor-pointer rounded-full border border-[var(--rc-line)] px-2.5 py-1 text-[12px] hover:text-bone disabled:cursor-default disabled:opacity-40"
					>
						none
					</button>
				</div>

				<div className="mt-3 flex flex-wrap gap-1">
					{QUICK_NUDGES.map((id) => {
						const nudge = GRADE_NUDGES.find((candidate) => candidate.id === id);
						if (!nudge) return null;
						return (
							<button
								key={id}
								type="button"
								onClick={() => run({ target, preset: id }, nudge.label)}
								className="rc-mono text-fog cursor-pointer rounded-full bg-[var(--rc-raised)] px-2 py-0.5 text-[11px] hover:text-bone"
							>
								{nudge.label}
							</button>
						);
					})}
				</div>

				{source && liveParams ? (
					<div className="mt-4 flex flex-col gap-4">
						{GROUPS.map((group) => (
							<div key={group.id} className="flex flex-col gap-2.5">
								<h4 className="text-[11px] tracking-[.14em] text-[var(--rc-mist)] uppercase">{group.label}</h4>
								{GRADE_PARAM_SPECS.filter((spec) => spec.group === group.id).map((spec) => (
									<label key={spec.key} className="flex flex-col gap-1.5" title={spec.hint}>
										<span className="flex items-baseline justify-between text-[12px]">
											<span className="text-[var(--rc-mist)]">{spec.label}</span>
											<span className="rc-mono text-bone text-[11px]">{formatValue(spec, params[spec.key])}</span>
										</span>
										<Slider
											min={spec.min}
											max={spec.max}
											step={spec.step}
											value={[params[spec.key]]}
											onValueChange={([value]) => previewParam(spec.key, value as number)}
											onValueCommit={() => editor.timeline.commitPreview()}
											aria-label={spec.label}
										/>
									</label>
								))}
							</div>
						))}
					</div>
				) : (
					<p className="text-fog mt-4 text-[12px] leading-relaxed">
						No grade on {scope === "clip" && !layerSelected ? "this clip" : "the video"} yet. Pick a look, or
						custom to start from neutral.
					</p>
				)}
			</div>

			<p className="rc-mono border-t px-4 py-2.5 text-[10.5px] text-[#5c5c64]">
				{source?.scope === "timeline" ? "GRADE layer · under the captions" : "on this clip · keyframe sliders in Effects"}
				{" · ctrl+z undoes"}
			</p>
		</div>
	);
}
