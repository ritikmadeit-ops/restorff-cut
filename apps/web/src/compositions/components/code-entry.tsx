"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import type { SceneTracks } from "@/timeline";
import { type CustomExample, fetchCustomExamples } from "../custom-api";
import { findMissingCustomRenders, repairCustomRender } from "../custom-drop";
import { type CodeDraft, CodeDialog } from "./code-dialog";

/**
 * Motion panel → "Write it as code" (motion-code agent, 2026-10-20): open the Code view blank or from a worked
 * example. Custom compositions Claude writes over MCP (`composition write`) land on the same MOTION track, marked Kiln.
 */
export function MotionCodeEntry() {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<CodeDraft | null>(null);
	const [examples, setExamples] = useState<CustomExample[]>([]);

	useEffect(() => {
		let alive = true;
		fetchCustomExamples()
			.then((list) => alive && setExamples(list))
			.catch(() => alive && setExamples([]));
		return () => {
			alive = false;
		};
	}, []);

	const start = (next: CodeDraft | null) => {
		setDraft(next);
		setOpen(true);
	};

	return (
		<section className="bg-surface border-line flex flex-col gap-2.5 rounded-[14px] border p-3">
			<span className="rc-label">Write it as code</span>
			<p className="text-fog text-[0.72rem] leading-snug">
				Your own motion graphic in HTML · CSS · JS: code in, alpha video out, on the MOTION track. The code stays in
				the clip.
			</p>
			<div className="flex flex-wrap gap-1">
				{examples.map((example) => (
					<button
						key={example.name}
						type="button"
						title={example.description}
						className="rc-mono border-line text-bone cursor-pointer rounded-full border px-2 py-0.5 text-[0.62rem] hover:border-[#5a5a63]"
						onClick={() => start({ source: example.source, props: example.props, duration: example.duration })}
					>
						{example.title}
					</button>
				))}
			</div>
			<button type="button" className="rc-pill h-8 px-3 text-[0.78rem]" onClick={() => start(null)}>
				Open the code view
			</button>
			<p className="rc-mono text-fog flex items-center gap-1.5 text-[0.62rem] leading-snug">
				<span aria-hidden className="bg-kiln size-1.5 shrink-0 rounded-full" />
				your Claude writes these too: MCP tool composition · write
			</p>
			<CodeDialog open={open} onOpenChange={setOpen} initial={draft} />
		</section>
	);
}

function activeTracks(editor: { scenes: { getActiveScene: () => { tracks: SceneTracks } } }): SceneTracks | null {
	try {
		return editor.scenes.getActiveScene().tracks;
	} catch {
		return null;
	}
}

/**
 * "N custom clips need re-rendering": a custom clip whose video is not in this browser (opened elsewhere, cache
 * cleared, pulled before its media). One click re-makes each from the code stored in the clip.
 */
export function CustomRepairBanner() {
	const editor = useEditor();
	const tracks = useEditor((e) => activeTracks(e));
	const assets = useEditor((e) => e.media.getAssets());
	const loading = useEditor((e) => e.media.isLoadingMedia());
	const [busy, setBusy] = useState(false);
	const missing = useMemo(
		() => findMissingCustomRenders({ tracks, mediaIds: new Set(assets.map((asset) => asset.id)), loading }),
		[tracks, assets, loading],
	);
	if (!missing.length) return null;

	const repairAll = async () => {
		setBusy(true);
		let done = 0;
		for (const item of missing) {
			try {
				await repairCustomRender({ editor, ref: item.ref });
				done++;
			} catch (error) {
				toast.error(`Couldn't re-render ${item.source.title ?? item.source.name}`, {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		}
		setBusy(false);
		if (done) toast.success(`${done} custom composition${done === 1 ? "" : "s"} re-rendered from code`);
	};

	return (
		<section className="mb-4 flex flex-col gap-2 rounded-[14px] border border-[#E8A33D]/60 bg-[#E8A33D]/[0.06] p-3">
			<span className="rc-label text-[#E8A33D]">
				{missing.length} custom clip{missing.length === 1 ? "" : "s"} · render missing
			</span>
			<p className="text-fog text-[0.72rem] leading-snug">
				{missing.map((item) => item.source.title ?? item.source.name).join(" · ")} — the code is in the project; the video
				is not on this machine yet.
			</p>
			<button type="button" className="rc-pill h-8 px-3 text-[0.78rem]" disabled={busy} onClick={() => void repairAll()}>
				{busy ? "Re-rendering…" : "Re-render from code"}
			</button>
		</section>
	);
}
