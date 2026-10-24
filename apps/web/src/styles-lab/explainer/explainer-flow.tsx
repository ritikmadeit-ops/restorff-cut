"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { colorName, styleCardFromReferences, type ExplainerAnswers, type StyleCard } from "@restorffcut/styles";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { KilnDot, Label, Pill } from "../ui";
import { buildExplainer, pickableMedia, type ExplainerBuildReport } from "./build";
import { extractReferences, filesFromDataTransfer, filesFromInput, type DroppedFile, type ExtractedReference } from "./extract";

/**
 * "Explainer from references" (EDT-21, reel DePNgrmToh9): drop folders of reference clips/images → thumbnails →
 * the style card Claude reads off them (palette, pacing, texture, motion; lettering left as a question) → the three
 * questions (footage, format, feel) → Build: a Paper collage explainer as ONE undoable change on the timeline.
 */
type Phase =
	| { kind: "drop" }
	| { kind: "reading"; done: number; total: number; current: string }
	| { kind: "card" }
	| { kind: "building"; step: string }
	| { kind: "done"; report: ExplainerBuildReport };

function Chips<T extends string>({ options, value, onChange }: { options: Array<{ value: T; label: string }>; value: T | undefined; onChange: (value: T) => void }) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onChange(option.value)}
					className={cn(
						"cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition-colors",
						value === option.value ? "border-bone bg-raised text-bone" : "border-outline text-mist hover:text-bone",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[76px_1fr] items-baseline gap-2">
			<Label tone="fog">{label}</Label>
			<div className="text-bone text-[0.78rem] leading-snug">{children}</div>
		</div>
	);
}

function parseDates(text: string): Array<{ date: string; text: string }> {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const match = /^(.{1,14}?)\s*[—–:-]\s*(.+)$/.exec(line);
			return match ? { date: (match[1] as string).trim(), text: (match[2] as string).trim() } : { date: line.slice(0, 14), text: "" };
		})
		.filter((item) => item.date && item.text);
}

export function ExplainerFlow() {
	const editor = useEditor();
	const hasProject = useEditor((e) => Boolean(e.project.getActiveOrNull()));
	// select the store's own array (stable reference), derive the pickable list from it
	const assets = useEditor((e) => e.media.getAssets());
	const media = useMemo(() => (hasProject ? pickableMedia(editor) : []), [assets, editor, hasProject]); // eslint-disable-line react-hooks/exhaustive-deps
	const [phase, setPhase] = useState<Phase>({ kind: "drop" });
	const [refs, setRefs] = useState<ExtractedReference[]>([]);
	const [problems, setProblems] = useState<string[]>([]);
	const [card, setCard] = useState<StyleCard | null>(null);
	const [answers, setAnswers] = useState<ExplainerAnswers>({});
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [beatsText, setBeatsText] = useState("");
	const [placesText, setPlacesText] = useState("");
	const [datesText, setDatesText] = useState("");
	const [more, setMore] = useState(false);
	const [dragging, setDragging] = useState(false);
	const folderInput = useRef<HTMLInputElement>(null);
	const filesInput = useRef<HTMLInputElement>(null);

	// React has no prop for directory pickers
	useEffect(() => {
		folderInput.current?.setAttribute("webkitdirectory", "");
		folderInput.current?.setAttribute("directory", "");
	}, []);

	const read = async (files: DroppedFile[]) => {
		if (!files.length) return;
		setPhase({ kind: "reading", done: 0, total: files.length, current: "" });
		try {
			const result = await extractReferences(files, { onProgress: (p) => setPhase({ kind: "reading", done: p.done, total: p.total, current: p.current }) });
			const all = [...refs, ...result.references];
			setRefs(all);
			setProblems([...result.failed, ...(result.skipped.length ? [`skipped ${result.skipped.length} file(s) that are not images or videos, or over the limit`] : [])]);
			if (!all.length) {
				toast.error("Nothing to study", { description: "Drop images or videos (png, jpg, webp, mp4, mov, webm)." });
				setPhase({ kind: "drop" });
				return;
			}
			const next = styleCardFromReferences(all);
			setCard(next);
			const suggested = (id: string) => next.questions.find((q) => q.id === id)?.suggested;
			setAnswers((current) => ({
				...current,
				footage: (current.footage ?? suggested("footage")) as ExplainerAnswers["footage"],
				format: (current.format ?? suggested("format")) as ExplainerAnswers["format"],
				feel: (current.feel ?? suggested("feel")) as ExplainerAnswers["feel"],
			}));
			setPhase({ kind: "card" });
		} catch (error) {
			toast.error("Couldn't read the references", { description: error instanceof Error ? error.message : String(error) });
			setPhase({ kind: refs.length ? "card" : "drop" });
		}
	};

	const reset = () => {
		setRefs([]);
		setCard(null);
		setProblems([]);
		setAnswers({});
		setPicked(new Set());
		setPhase({ kind: "drop" });
	};

	const build = async () => {
		if (!card || !hasProject) return;
		const full: ExplainerAnswers = {
			...answers,
			...(beatsText.trim() ? { beats: beatsText.split("\n").map((l) => l.trim()).filter(Boolean) } : {}),
			...(placesText.trim() ? { places: placesText.split(/[,→>\n]+/).map((p) => p.trim()).filter(Boolean) } : {}),
			...(datesText.trim() ? { dates: parseDates(datesText) } : {}),
		};
		setPhase({ kind: "building", step: "planning…" });
		try {
			const report = await buildExplainer({
				editor,
				card,
				answers: full,
				assetIds: full.footage === "none" ? [] : [...picked],
				onStep: (step) => setPhase({ kind: "building", step }),
			});
			setPhase({ kind: "done", report });
			if (report.committed) toast.success(`Explainer built: ${report.beats.length} beats, ${report.duration} s`, { description: "One change on the timeline: Ctrl+Z undoes it." });
			else toast.error("Nothing could be placed", { description: report.skipped.slice(0, 2).join(" · ") || report.failed.slice(0, 2).join(" · ") });
		} catch (error) {
			toast.error("The build failed", { description: error instanceof Error ? error.message : String(error) });
			setPhase({ kind: "card" });
		}
	};

	const footageOptions = media.filter((asset) => (answers.footage === "stills" ? asset.kind === "image" : true));
	const typeOptions = useMemo(() => (card?.type.options ?? []).map((option) => ({ value: option, label: option })), [card]);

	// ── drop ─────────────────────────────────────────────────────────────────────────────────────────────────────
	if (phase.kind === "drop" || phase.kind === "reading") {
		return (
			<div className="flex flex-col gap-3">
				<p className="text-fog text-[0.74rem] leading-snug">
					Drop folders of reference clips or images. Claude reads the look off them (palette, pacing, texture), asks three questions, then builds a Paper collage explainer as an editable timeline. References are studied here and never added to the project.
				</p>
				<div
					onDragOver={(event) => {
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(event) => {
						event.preventDefault();
						setDragging(false);
						void filesFromDataTransfer(event.dataTransfer).then(read);
					}}
					className={cn(
						"flex min-h-36 flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed px-4 py-6 text-center transition-colors",
						dragging ? "border-bone bg-raised" : "border-outline bg-surface",
					)}
				>
					{phase.kind === "reading" ? (
						<>
							<Label>studying references</Label>
							<span className="rc-mono text-mist text-[0.72rem]">
								{phase.done}/{phase.total} {phase.current}
							</span>
						</>
					) : (
						<>
							<Label>drop reference folders</Label>
							<span className="text-fog text-[0.72rem]">images and videos · up to 40 + 8</span>
							<div className="mt-1 flex gap-2">
								<Pill onClick={() => folderInput.current?.click()}>Choose folder…</Pill>
								<Pill onClick={() => filesInput.current?.click()}>Files…</Pill>
							</div>
						</>
					)}
				</div>
				<input ref={folderInput} type="file" multiple className="hidden" onChange={(event) => { void read(filesFromInput(event.target.files)); event.target.value = ""; }} />
				<input ref={filesInput} type="file" multiple accept="image/*,video/*" className="hidden" onChange={(event) => { void read(filesFromInput(event.target.files)); event.target.value = ""; }} />
			</div>
		);
	}

	// ── building / done ──────────────────────────────────────────────────────────────────────────────────────────
	if (phase.kind === "building") {
		return (
			<div className="border-outline bg-surface flex flex-col gap-1.5 rounded-[14px] border px-3 py-3">
				<div className="flex items-center gap-2">
					<KilnDot />
					<Label tone="kiln">building the explainer</Label>
				</div>
				<span className="text-mist text-[0.76rem]">{phase.step}</span>
			</div>
		);
	}

	if (phase.kind === "done") {
		const { report } = phase;
		return (
			<div className="flex flex-col gap-3">
				<div className="border-outline bg-surface flex flex-col gap-2 rounded-[14px] border px-3 py-3">
					<div className="flex items-baseline justify-between gap-2">
						<Label>{report.committed ? "built" : "nothing placed"}</Label>
						<span className="rc-mono text-fog text-[0.64rem]">
							{report.applied} ops · {report.beats.length} beats · {report.duration} s from {report.start.toFixed(1)} s
						</span>
					</div>
					<ol className="flex flex-col gap-1">
						{report.beats.map((beat) => (
							<li key={beat.index} className="grid grid-cols-[52px_1fr] gap-2 text-[0.74rem] leading-snug">
								<span className="rc-mono text-fog">
									{beat.start.toFixed(1)}–{beat.end.toFixed(1)}
								</span>
								<span className="text-bone">
									{beat.visual || beat.kind}
									{beat.line ? <span className="text-fog"> · “{beat.line}”</span> : null}
								</span>
							</li>
						))}
					</ol>
					{report.effects.length > 0 && <p className="text-mist text-[0.7rem] leading-snug">Effects: {report.effects.join(" · ")}</p>}
				</div>
				{(report.failed.length > 0 || report.skipped.length > 0) && (
					<div className="text-stale flex flex-col gap-0.5 text-[0.7rem] leading-snug">
						{report.failed.map((line) => (
							<span key={line}>· not rendered: {line}</span>
						))}
						{report.skipped.slice(0, 4).map((line) => (
							<span key={line}>· skipped {line}</span>
						))}
					</div>
				)}
				<div className="flex flex-col gap-1">
					<Label tone="fog">not built yet</Label>
					{report.missing.map((line) => (
						<span key={line} className="text-fog text-[0.7rem] leading-snug">
							· {line}
						</span>
					))}
					{[...report.pending, ...report.notes].map((line) => (
						<span key={line} className="text-fog text-[0.7rem] leading-snug">
							· {line}
						</span>
					))}
				</div>
				<div className="flex flex-wrap gap-2">
					<Pill
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(report.changeNote);
								toast.success("Change note copied");
							} catch {
								toast.error("Couldn't copy", { description: report.changeNote });
							}
						}}
					>
						Copy change note
					</Pill>
					{report.committed && (
						<Pill
							onClick={() => {
								editor.command.undo();
								setPhase({ kind: "card" });
								toast("Explainer removed (undone)");
							}}
						>
							Undo build
						</Pill>
					)}
					<Pill onClick={() => setPhase({ kind: "card" })}>Back to the card</Pill>
				</div>
			</div>
		);
	}

	// ── the card + questions ─────────────────────────────────────────────────────────────────────────────────────
	if (!card) return null;
	const footageQ = card.questions.find((q) => q.id === "footage");
	const formatQ = card.questions.find((q) => q.id === "format");
	const feelQ = card.questions.find((q) => q.id === "feel");
	return (
		<div className="flex flex-col gap-4 pb-6">
			{/* thumbnails */}
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<Label>references · {refs.length}</Label>
					<div className="flex gap-2">
						<button type="button" onClick={() => folderInput.current?.click()} className="rc-mono text-fog hover:text-bone cursor-pointer text-[0.62rem]">
							+ add
						</button>
						<button type="button" onClick={reset} className="rc-mono text-fog hover:text-bone cursor-pointer text-[0.62rem]">
							start over
						</button>
					</div>
				</div>
				<div className="grid grid-cols-4 gap-1.5">
					{refs.slice(0, 12).map((ref) => (
						<div key={`${ref.folder ?? ""}/${ref.name}`} className="bg-raised relative aspect-[9/16] overflow-hidden rounded-[6px]" title={`${ref.folder ? `${ref.folder} / ` : ""}${ref.name}`}>
							{ref.thumbnail ? <img src={ref.thumbnail} alt="" className="size-full object-cover" /> : null}
							{ref.kind === "video" && <span className="rc-mono absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[0.55rem] text-white">{ref.duration?.toFixed(0)}s</span>}
						</div>
					))}
				</div>
				{refs.length > 12 && <span className="rc-mono text-fog text-[0.62rem]">+{refs.length - 12} more</span>}
				{problems.map((line) => (
					<span key={line} className="text-stale text-[0.68rem]">
						· {line}
					</span>
				))}
				<input ref={folderInput} type="file" multiple className="hidden" onChange={(event) => { void read(filesFromInput(event.target.files)); event.target.value = ""; }} />
			</div>

			{/* the style card */}
			<div className="border-outline bg-surface flex flex-col gap-2.5 rounded-[16px] border px-3.5 py-3">
				<div className="flex items-center gap-2">
					<KilnDot />
					<Label tone="kiln">style card</Label>
					<span className="rc-mono text-fog ml-auto text-[0.6rem]">{card.references.frames} frames read</span>
				</div>
				<div className="flex h-9 overflow-hidden rounded-[8px]">
					{card.palette.map((color) => (
						<div key={color.hex} style={{ background: color.hex, flexGrow: Math.max(0.06, color.share) }} title={`${color.hex} · ${colorName(color.hex)} · ${color.role} · ${Math.round(color.share * 100)} %`} />
					))}
				</div>
				<div className="flex flex-wrap gap-x-3 gap-y-1">
					{card.palette.map((color) => (
						<span key={color.hex} className="rc-mono text-mist flex items-center gap-1 text-[0.62rem]">
							<span className="inline-block size-2.5 rounded-sm" style={{ background: color.hex }} />
							{color.hex} {color.role !== "tone" ? color.role : colorName(color.hex)} {Math.round(color.share * 100)}%
						</span>
					))}
				</div>
				<Row label="mood">
					{card.mood.label} · brightness {Math.round(card.mood.brightness * 100)} % · contrast {Math.round(card.mood.contrast * 100)} %
				</Row>
				<Row label="texture">
					{card.texture.label}
					{card.texture.grain !== null ? <span className="rc-mono text-fog"> · grain {card.texture.grain}</span> : null}
					{card.texture.paper ? " · reads as paper" : ""}
				</Row>
				<Row label="pacing">
					{card.pacing.avgShot !== null ? `${card.pacing.avgShot} s a shot · ${card.pacing.cutsPer10s} cuts / 10 s · ${card.pacing.label}` : card.pacing.label}
				</Row>
				<Row label="motion">{card.motion.label}</Row>
				<Row label="type">
					<div className="flex flex-col gap-1.5">
						<span className="text-fog">{card.type.question} (not guessed from pixels)</span>
						<Chips options={typeOptions} value={answers.type} onChange={(type) => setAnswers((a) => ({ ...a, type }))} />
					</div>
				</Row>
				{card.notes.length > 0 && (
					<div className="flex flex-col gap-0.5 border-t border-hairline pt-2">
						{card.notes.map((note) => (
							<span key={note} className="text-fog text-[0.66rem] leading-snug">
								· {note}
							</span>
						))}
					</div>
				)}
			</div>

			{/* the three questions */}
			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-2">
					<KilnDot />
					<Label tone="kiln">three questions</Label>
				</div>
				{footageQ && (
					<div className="flex flex-col gap-1.5">
						<span className="text-bone text-[0.8rem]">{footageQ.ask}</span>
						<Chips options={footageQ.options} value={answers.footage} onChange={(footage) => setAnswers((a) => ({ ...a, footage: footage as ExplainerAnswers["footage"] }))} />
						{answers.footage !== "none" && (
							<div className="flex flex-col gap-1">
								{footageOptions.length === 0 ? (
									<span className="text-fog text-[0.7rem]">No {answers.footage === "stills" ? "images" : "clips or images"} in this project yet: import them in Media first.</span>
								) : (
									<div className="grid max-h-44 grid-cols-2 gap-1 overflow-y-auto">
										{footageOptions.map((asset) => {
											const on = picked.has(asset.id);
											return (
												<button
													key={asset.id}
													type="button"
													onClick={() =>
														setPicked((current) => {
															const next = new Set(current);
															if (on) next.delete(asset.id);
															else next.add(asset.id);
															return next;
														})
													}
													className={cn(
														"flex cursor-pointer items-center gap-1.5 rounded-[8px] border px-2 py-1 text-left text-[0.7rem]",
														on ? "border-bone text-bone bg-raised" : "border-outline text-mist hover:text-bone",
													)}
												>
													<span className="rc-mono text-fog text-[0.58rem] uppercase">{asset.kind === "video" ? "clip" : "still"}</span>
													<span className="truncate">{asset.name}</span>
												</button>
											);
										})}
									</div>
								)}
								<span className="rc-mono text-fog text-[0.6rem]">{picked.size} picked · cut at {card.pacing.avgShot ?? 2.2} s a shot</span>
							</div>
						)}
					</div>
				)}
				{formatQ && (
					<div className="flex flex-col gap-1.5">
						<span className="text-bone text-[0.8rem]">{formatQ.ask}</span>
						<Chips options={formatQ.options} value={answers.format} onChange={(format) => setAnswers((a) => ({ ...a, format: format as ExplainerAnswers["format"] }))} />
					</div>
				)}
				{feelQ && (
					<div className="flex flex-col gap-1.5">
						<span className="text-bone text-[0.8rem]">{feelQ.ask}</span>
						<Chips options={feelQ.options} value={answers.feel} onChange={(feel) => setAnswers((a) => ({ ...a, feel: feel as ExplainerAnswers["feel"] }))} />
					</div>
				)}
				<label className="flex flex-col gap-1.5">
					<span className="text-bone text-[0.8rem]">What does it explain?</span>
					<input
						value={answers.topic ?? ""}
						onChange={(event) => setAnswers((a) => ({ ...a, topic: event.target.value }))}
						placeholder="How the farm-to-bottle route works"
						className="bg-ground border-outline text-bone rounded-[10px] border px-3 py-2 text-[0.82rem] outline-none focus:border-fog"
					/>
				</label>
				<button type="button" onClick={() => setMore((v) => !v)} className="rc-mono text-fog hover:text-bone cursor-pointer self-start text-[0.64rem]">
					{more ? "− fewer options" : "+ script, places, dates (optional)"}
				</button>
				{more && (
					<div className="flex flex-col gap-2.5">
						<label className="flex flex-col gap-1">
							<Label tone="fog">one line per beat</Label>
							<textarea value={beatsText} onChange={(event) => setBeatsText(event.target.value)} rows={5} placeholder={"How the farm-to-bottle route works\nIt starts on a highland farm\n…"} className="bg-ground border-outline text-bone resize-none rounded-[10px] border px-3 py-2 text-[0.78rem] leading-snug outline-none focus:border-fog" />
						</label>
						<label className="flex flex-col gap-1">
							<Label tone="fog">map stops, in order</Label>
							<input value={placesText} onChange={(event) => setPlacesText(event.target.value)} placeholder="Farm, Roastery, Café downtown" className="bg-ground border-outline text-bone rounded-[10px] border px-3 py-2 text-[0.78rem] outline-none focus:border-fog" />
						</label>
						<label className="flex flex-col gap-1">
							<Label tone="fog">dated facts (date — line)</Label>
							<textarea value={datesText} onChange={(event) => setDatesText(event.target.value)} rows={3} placeholder={"2019 — First batch, one kitchen\n2026 — Bottled in 12 cities"} className="bg-ground border-outline text-bone resize-none rounded-[10px] border px-3 py-2 text-[0.78rem] leading-snug outline-none focus:border-fog" />
						</label>
						<div className="grid grid-cols-2 gap-2">
							<label className="flex flex-col gap-1">
								<Label tone="fog">tiles word</Label>
								<input value={answers.number ?? ""} maxLength={10} onChange={(event) => setAnswers((a) => ({ ...a, number: event.target.value }))} placeholder="18H" className="bg-ground border-outline text-bone rounded-[10px] border px-3 py-2 text-[0.78rem] outline-none focus:border-fog" />
							</label>
							<label className="flex flex-col gap-1">
								<Label tone="fog">end stamp</Label>
								<input value={answers.verdict ?? ""} maxLength={16} onChange={(event) => setAnswers((a) => ({ ...a, verdict: event.target.value }))} placeholder="SMALL BATCH" className="bg-ground border-outline text-bone rounded-[10px] border px-3 py-2 text-[0.78rem] outline-none focus:border-fog" />
							</label>
						</div>
					</div>
				)}
			</div>

			<div className="flex items-center gap-2">
				<Pill isolate onClick={() => void build()} disabled={!hasProject || (answers.footage !== "none" && picked.size === 0 && footageOptions.length > 0)}>
					Build the explainer
				</Pill>
				<span className="text-fog text-[0.68rem] leading-snug">Appended after your cut · one undo step</span>
			</div>
		</div>
	);
}
