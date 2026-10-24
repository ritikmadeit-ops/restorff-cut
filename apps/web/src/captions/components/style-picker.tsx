"use client";

import { useEffect } from "react";
import { CAPTION_STYLE_PRESETS, type CaptionStylePreset } from "@restorffcut/timeline-ops";
import { loadFonts } from "@/fonts/google-fonts";
import { cn } from "@/utils/ui";

const SAMPLE = ["cold", "brew", "daily"];

/** A small 9:16 card that draws the style roughly the way the renderer will (font, case, box, highlight). */
function StylePreview({ style }: { style: CaptionStylePreset }) {
	const base = style.base;
	const words = SAMPLE.slice(0, Math.max(1, style.maxWords)).map((word) => (base.uppercase ? word.toUpperCase() : word));
	const fontSize = Math.min(22, Math.max(9, (base.size ?? 5) * 2.1));
	const highlight = style.highlight;
	return (
		<div
			className="relative flex aspect-[9/12] w-full items-center justify-center overflow-hidden rounded-[10px]"
			style={{ background: "linear-gradient(180deg, #2a2620 0%, #16161A 70%)" }}
		>
			<div className="absolute bottom-0 left-1/2 h-[46%] w-[26%] -translate-x-1/2 rounded-t-[999px] bg-[#0C0C0E]" />
			<div
				className="relative px-1 text-center leading-tight"
				style={{
					fontFamily: `"${base.font}", sans-serif`,
					fontWeight: base.weight === "bold" ? 700 : 400,
					fontSize,
					color: base.color,
					letterSpacing: base.letter_spacing ? `${base.letter_spacing / 4}px` : undefined,
					background: base.bg ? base.bg_color : undefined,
					borderRadius: base.bg ? 4 : undefined,
					padding: base.bg ? "1px 6px" : undefined,
					textShadow: style.shadow ? "0 1px 0 rgba(0,0,0,.6)" : undefined,
					marginTop: `${(style.anchor - 0.5) * 70}%`,
				}}
			>
				{words.map((word, index) => {
					const active = index === Math.min(1, words.length - 1);
					if (highlight.kind === "word-box" && active) {
						return (
							<span
								key={word}
								style={{ background: highlight.bg_color, color: highlight.color, borderRadius: 3, padding: "0 2px" }}
							>
								{word}{" "}
							</span>
						);
					}
					if (highlight.kind === "karaoke" && index <= Math.min(1, words.length - 1)) {
						return (
							<span key={word} style={{ color: highlight.color }}>
								{word}{" "}
							</span>
						);
					}
					return <span key={word}>{word} </span>;
				})}
			</div>
		</div>
	);
}

export function CaptionStylePicker({
	value,
	onPick,
	disabled,
}: {
	value: string;
	onPick: (id: string) => void;
	disabled?: boolean;
}) {
	useEffect(() => {
		void loadFonts({ families: [...new Set(CAPTION_STYLE_PRESETS.map((style) => style.base.font ?? "Arial"))] });
	}, []);

	return (
		<div className="grid grid-cols-2 gap-2">
			{CAPTION_STYLE_PRESETS.map((style) => (
				<button
					key={style.id}
					type="button"
					disabled={disabled}
					onClick={() => onPick(style.id)}
					title={`${style.hint} — ${style.source}`}
					className={cn(
						"bg-surface flex cursor-pointer flex-col gap-1.5 rounded-[14px] border p-1.5 text-left transition-colors disabled:cursor-default disabled:opacity-60",
						value === style.id ? "border-bone" : "border-line hover:border-bone/40",
					)}
				>
					<StylePreview style={style} />
					<span className="px-1 pb-0.5">
						<span className="text-bone block text-[0.72rem] font-semibold leading-tight">{style.label}</span>
						<span className="text-fog block text-[0.64rem] leading-tight">{style.hint}</span>
					</span>
				</button>
			))}
		</div>
	);
}
