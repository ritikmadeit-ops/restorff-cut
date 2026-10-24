"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { designTheSound } from "./apply";
import { useSoundDesignStore } from "./store";

/**
 * "Design the sound" — the owner's rule as one button (README "Sound is half the ad"). Places named SFX from the
 * built-in pack on the visual events of the open cut and ducks the music lightly; one undo step. See ./apply.ts.
 */
export function DesignTheSound() {
	const editor = useEditor();
	const projectId = useEditor((e) => e.project.getActiveOrNull()?.metadata.id);
	const [busy, setBusy] = useState(false);
	const captionTicks = useSoundDesignStore((s) => s.captionTicks);
	const duck = useSoundDesignStore((s) => s.duck);
	const setCaptionTicks = useSoundDesignStore((s) => s.setCaptionTicks);
	const setDuck = useSoundDesignStore((s) => s.setDuck);
	const report = useSoundDesignStore((s) => (projectId ? s.reportByProject[projectId] : undefined));
	const setReport = useSoundDesignStore((s) => s.setReport);

	const run = async () => {
		if (!projectId || busy) return;
		setBusy(true);
		try {
			const result = await designTheSound({ editor, options: { captionTicks, duck } });
			setReport({ projectId, report: result });
			const detail = [
				result.replaced ? `replaced ${result.replaced} from the last run` : null,
				result.dropped ? `${result.dropped} skipped by the 0.25 s rule` : null,
				"undo: Ctrl+Z",
			]
				.filter(Boolean)
				.join(" · ");
			if (result.placed.length) toast.success(result.summary, { description: detail });
			else toast.message(result.summary, { description: result.notes.join(" · ") || detail });
		} catch (error) {
			toast.error("Couldn't design the sound", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="bg-surface border-line mb-5 flex flex-col gap-3 rounded-[16px] border p-3.5">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<h3 className="rc-label text-bone text-[0.7rem]">Sound is half the ad</h3>
					<p className="text-fog text-[0.7rem] leading-snug">
						A hit on frame 1, a riser into the end of the hook, a whoosh on every cut, a pop on every text in.
						Named, ≥ 0.25 s apart, music ducked 3 dB under them.
					</p>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
				<Toggle label="Duck the music" checked={duck} onChange={setDuck} />
				<Toggle label="Tick on captions" checked={captionTicks} onChange={setCaptionTicks} />
			</div>
			<button
				type="button"
				onClick={() => void run()}
				disabled={!projectId || busy}
				className={cn(
					"rc-label border-bone/70 text-bone hover:bg-bone w-full cursor-pointer rounded-full border px-4 py-2 text-[0.72rem] transition-colors hover:text-[#0C0C0E]",
					"disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-bone",
				)}
			>
				{busy ? "Designing…" : report ? "Design the sound again" : "Design the sound"}
			</button>
			{report && (
				<div className="flex flex-col gap-1">
					<p className="rc-mono text-bone text-[0.68rem] leading-relaxed">{report.summary}</p>
					{report.replaced > 0 && (
						<p className="rc-mono text-fog text-[0.64rem]">replaced {report.replaced} SFX from the last run</p>
					)}
					{report.notes.map((line) => (
						<p key={line} className="text-[0.66rem] leading-snug text-[#5c5c64]">
							{line}
						</p>
					))}
					{report.skipped.map((line) => (
						<p key={line} className="text-[0.66rem] leading-snug text-[#E8A33D]">
							{line}
						</p>
					))}
				</div>
			)}
		</section>
	);
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
	return (
		<label className="text-fog hover:text-bone flex cursor-pointer items-center gap-1.5 text-[0.7rem] select-none">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="accent-[#EDEBE6] size-3"
			/>
			{label}
		</label>
	);
}
