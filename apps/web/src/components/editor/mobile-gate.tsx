"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/wordmark";
import { PARENT_PRODUCT_NAME, PRODUCT_NAME } from "@/site/brand";

const STORAGE_KEY = "restorffcut-mobile-acknowledged";

interface MobileGateProps {
	children: React.ReactNode;
}

const NARROW_QUERY = "(max-width: 1023.98px)";

/**
 * Below 1024 px the editor shows this gate: RestorffCut is desktop-only for now. It switches LIVE (ui-fix-panels,
 * QA #14: shrinking an open editor to 390 px left the squashed layout): a media query listener shows the gate when
 * the window gets narrow and the editor again when it widens. An editor that was already open stays mounted under
 * the gate (hidden), so nothing is lost by resizing; a fresh narrow load never mounts it.
 */
export function MobileGate({ children }: MobileGateProps) {
	const router = useRouter();
	const [narrow, setNarrow] = useState<boolean | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const [editorMounted, setEditorMounted] = useState(false);

	useEffect(() => {
		try {
			setAcknowledged(localStorage.getItem(STORAGE_KEY) === "true");
		} catch {
			setAcknowledged(false);
		}
		const query = window.matchMedia(NARROW_QUERY);
		const update = () => setNarrow(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	const show = narrow === true && !acknowledged;
	useEffect(() => {
		if (narrow !== null && !show) setEditorMounted(true);
	}, [narrow, show]);

	if (narrow === null) return null;
	const editor = editorMounted || !show ? (
		<div className={show ? "hidden" : "contents"} aria-hidden={show || undefined}>
			{children}
		</div>
	) : null;
	// same tree shape either way (editor first), so switching never remounts the editor
	if (!show)
		return (
			<>
				{editor}
				{null}
			</>
		);

	const handleContinue = () => {
		try {
			localStorage.setItem(STORAGE_KEY, "true");
		} catch {
			// storage blocked: continue for this visit only
		}
		setAcknowledged(true);
	};

	const handleGoBack = () => {
		if (window.history.length > 1) {
			router.back();
		} else {
			router.push("/projects");
		}
	};

	return (
		<>
		{editor}
		<div className="bg-background relative flex min-h-dvh w-screen flex-col overflow-hidden px-6 py-6">
			<header className="flex items-center justify-between">
				<Wordmark size="sm" />
				<button
					type="button"
					onClick={handleGoBack}
					className="rc-mono text-fog cursor-pointer text-xs hover:text-bone"
				>
					← back
				</button>
			</header>

			<div className="flex flex-1 flex-col justify-center gap-8">
				<div className="flex flex-col gap-4">
					<span className="rc-label">Edit · desktop only</span>
					<h1 className="rc-display text-[2.4rem] leading-[0.98]">
						Open this on a desktop
					</h1>
					<p className="text-[0.95rem] leading-relaxed text-[#C9C7C2]">
						{PRODUCT_NAME} needs a screen at least 1024 px wide for the
						preview, inspector and timeline. On a phone the layout breaks.
					</p>
					<p className="rc-mono text-fog text-xs">
						in {PARENT_PRODUCT_NAME} · Edit · min width 1024 px
					</p>
				</div>
				<div className="flex flex-col gap-3">
					{/* The one neon isolate on this view: the action waiting on you. */}
					<button
						type="button"
						className="bg-neon h-11 w-full cursor-pointer rounded-full text-[0.95rem] font-bold text-[#0C0C0E] shadow-[0_0_32px_-8px_rgba(246,255,0,0.55)]"
						onClick={handleGoBack}
					>
						Go back
					</button>
					<button
						type="button"
						onClick={handleContinue}
						className="rc-mono text-fog cursor-pointer py-2 text-xs underline-offset-4 hover:text-bone hover:underline"
					>
						open the editor anyway
					</button>
				</div>
			</div>
		</div>
		</>
	);
}
