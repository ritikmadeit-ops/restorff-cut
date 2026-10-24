"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { slugify, validateStylePreset, type SavedStyle, type StyleParamSpec } from "@restorffcut/styles";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useStylesLabStore } from "./store";
import { describeStep, KilnDot, Label, Pill } from "./ui";

/**
 * The "Save as style" sheet (EDT-20): name it, edit its trigger sentences and params, save. Saving an id that exists
 * makes a new version (the old one is kept). Mounted ONCE, by SavedStylesSection (picker-section.tsx); everything
 * else opens it through the store (`openSheet`).
 */
export function SaveStyleSheet() {
	const sheet = useStylesLabStore((s) => s.sheet);
	const library = useStylesLabStore((s) => s.library);
	const closeSheet = useStylesLabStore((s) => s.closeSheet);
	const save = useStylesLabStore((s) => s.save);
	const dismiss = useStylesLabStore((s) => s.dismiss);
	const [title, setTitle] = useState("");
	const [triggers, setTriggers] = useState("");
	const [params, setParams] = useState<Record<string, StyleParamSpec>>({});
	const [note, setNote] = useState("");

	const draft = sheet.draft;
	useEffect(() => {
		if (!draft) return;
		setTitle(draft.title);
		setTriggers(draft.triggers.join("\n"));
		setParams(structuredClone(draft.params ?? {}));
		setNote("");
	}, [draft]);

	if (!draft) return null;
	const id = sheet.editing ? draft.id : slugify(title || draft.title);
	const existing = library.styles[id];
	const lines = triggers
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const onSave = () => {
		const style: SavedStyle = { ...draft, id, title: title.trim() || draft.title, triggers: lines, params };
		const problems = validateStylePreset(style);
		if (problems.length) {
			toast.error("Can't save this style", { description: problems.join(" · ") });
			return;
		}
		try {
			const saved = save({ style, note: note.trim() || undefined });
			toast.success(`Saved “${saved.title}” · v${saved.version}`, {
				description: `Say “${saved.triggers[0]}” or pick it under My styles.`,
			});
			closeSheet();
		} catch (error) {
			toast.error("Couldn't save", { description: error instanceof Error ? error.message : String(error) });
		}
	};

	const setDefault = (name: string, value: unknown) =>
		setParams((current) => {
			const spec = current[name];
			if (!spec) return current;
			return { ...current, [name]: { ...spec, default: value } as StyleParamSpec };
		});

	return (
		<Sheet open={sheet.open} onOpenChange={(open) => !open && closeSheet()}>
			<SheetContent side="right" className="bg-surface border-outline flex w-[420px] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[420px]">
				<div className="flex flex-col gap-1.5 border-b border-hairline px-6 pt-6 pb-4">
					<div className="flex items-center gap-2">
						<KilnDot />
						<Label tone="kiln">{sheet.editing ? "edit saved style" : "save as style"}</Label>
					</div>
					<SheetTitle className="text-bone text-[1.05rem] font-semibold">{sheet.editing ? draft.title : "Make this a style you can reuse"}</SheetTitle>
					<SheetDescription className="text-fog text-[0.78rem] leading-snug">
						{draft.origin
							? `You asked for this ${draft.origin.count} times${draft.origin.projects > 1 ? ` on ${draft.origin.projects} projects` : ""}. Save it once; say a trigger sentence or pick it from My styles next time.`
							: "Saving again makes a new version; the old one is kept."}
					</SheetDescription>
				</div>

				<div className="flex flex-col gap-5 px-6 py-5">
					<label className="flex flex-col gap-1.5">
						<Label>Name</Label>
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							disabled={sheet.editing}
							className="bg-ground border-outline text-bone rounded-[10px] border px-3 py-2 text-[0.9rem] outline-none focus:border-fog disabled:opacity-70"
						/>
						<span className="rc-mono text-fog text-[0.68rem]">
							{id} · {existing ? `saves v-next of v${existing.version}` : "v1.0.0"}
						</span>
					</label>

					<label className="flex flex-col gap-1.5">
						<Label>Trigger sentences · one per line</Label>
						<textarea
							value={triggers}
							onChange={(event) => setTriggers(event.target.value)}
							rows={Math.min(6, Math.max(3, lines.length + 1))}
							className="bg-ground border-outline text-bone resize-none rounded-[10px] border px-3 py-2 text-[0.85rem] leading-snug outline-none focus:border-fog"
						/>
						<span className="text-fog text-[0.7rem]">Wording is matched loosely: “bigger captions please” = “captions bigger”.</span>
					</label>

					<div className="flex flex-col gap-1.5">
						<Label>What it does</Label>
						<ul className="flex flex-col gap-1">
							{draft.steps.map((step, index) => (
								<li key={`${step.kind}-${index}`} className="text-mist text-[0.8rem] leading-snug">
									· {describeStep(step)}
								</li>
							))}
						</ul>
					</div>

					{Object.keys(params).length > 0 && (
						<div className="flex flex-col gap-2">
							<Label>Settings</Label>
							{Object.entries(params).map(([name, spec]) => (
								<label key={name} className="grid grid-cols-[1fr_auto] items-center gap-3">
									<span className="text-mist text-[0.8rem]">{spec.label ?? name}</span>
									{spec.type === "number" ? (
										<input
											type="number"
											step="0.05"
											value={spec.default}
											onChange={(event) => setDefault(name, Number(event.target.value))}
											className="rc-mono bg-ground border-outline text-bone w-24 rounded-[8px] border px-2 py-1 text-right text-[0.8rem] outline-none"
										/>
									) : spec.type === "color" ? (
										<span className="flex items-center gap-2">
											<input type="color" value={spec.default} onChange={(event) => setDefault(name, event.target.value.toUpperCase())} className="size-7 cursor-pointer rounded border-0 bg-transparent" />
											<span className="rc-mono text-fog text-[0.72rem]">{spec.default}</span>
										</span>
									) : spec.type === "boolean" ? (
										<input type="checkbox" checked={spec.default} onChange={(event) => setDefault(name, event.target.checked)} />
									) : (
										<input
											value={spec.default}
											onChange={(event) => setDefault(name, event.target.value)}
											className="bg-ground border-outline text-bone w-36 rounded-[8px] border px-2 py-1 text-[0.8rem] outline-none"
										/>
									)}
								</label>
							))}
						</div>
					)}

					{existing && (
						<label className="flex flex-col gap-1.5">
							<Label>Change note</Label>
							<input
								value={note}
								onChange={(event) => setNote(event.target.value)}
								placeholder="what changed in this version"
								className="bg-ground border-outline text-bone rounded-[10px] border px-3 py-2 text-[0.85rem] outline-none focus:border-fog"
							/>
						</label>
					)}
				</div>

				<div className="mt-auto flex items-center gap-2 border-t border-hairline px-6 py-4">
					<Pill isolate onClick={onSave} disabled={!lines.length}>
						{existing ? `Save v-next` : "Save style"}
					</Pill>
					<Pill onClick={closeSheet}>Not now</Pill>
					{!sheet.editing && sheet.pattern && (
						<button
							type="button"
							onClick={() => {
								dismiss(sheet.pattern as string);
								closeSheet();
								toast("Won't suggest that one again");
							}}
							className="text-fog hover:text-bone ml-auto cursor-pointer text-[0.72rem]"
						>
							Never for this
						</button>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
