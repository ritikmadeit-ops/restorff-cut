"use client";

import { cn } from "@/utils/ui";
import {
	type CatalogueEffect,
	EFFECT_GROUPS,
	EFFECTS_CATALOGUE,
	type EffectStatus,
	catalogueCounts,
} from "../effects-catalogue";

const STATUS_LABEL: Record<EffectStatus, string> = {
	available: "ready",
	partial: "partial",
	coming: "coming",
};

/**
 * Every effect from docs/restorff/EFFECTS.md with its honest status. Only rows that work today have an action
 * (open the composition, or add the shader effect at the playhead); "coming" rows say what they wait on.
 */
export function EffectsLibrary({
	onUse,
}: {
	onUse: (effect: CatalogueEffect) => void;
}) {
	const counts = catalogueCounts();
	return (
		<div className="flex flex-col gap-5 pb-6">
			<p className="rc-mono text-fog text-[0.68rem] leading-relaxed">
				{EFFECTS_CATALOGUE.length} effects from the reels · {counts.available} ready · {counts.partial} partial ·{" "}
				{counts.coming} coming
			</p>
			{EFFECT_GROUPS.map((group) => (
				<section key={group} className="flex flex-col gap-1">
					<h3 className="rc-label mb-1">{group}</h3>
					{EFFECTS_CATALOGUE.filter((effect) => effect.group === group).map((effect) => (
						<LibraryRow key={effect.id} effect={effect} onUse={onUse} />
					))}
				</section>
			))}
		</div>
	);
}

function LibraryRow({
	effect,
	onUse,
}: {
	effect: CatalogueEffect;
	onUse: (effect: CatalogueEffect) => void;
}) {
	const usable = effect.status !== "coming" && effect.via && effect.via.kind !== "editor";
	return (
		<div
			className={cn(
				"border-line flex flex-col gap-1 rounded-[10px] border px-2.5 py-2",
				effect.status === "coming" && "border-transparent bg-transparent opacity-70",
				effect.status !== "coming" && "bg-surface",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="rc-mono shrink-0 text-[0.62rem] text-fog">{effect.id.replace("FX-", "")}</span>
				<span className="min-w-0 flex-1 truncate text-[0.8rem] font-medium text-bone">{effect.name}</span>
				<span
					className={cn(
						"rc-mono shrink-0 rounded-full border px-1.5 text-[0.58rem] uppercase",
						effect.status === "available" && "border-[#EDEBE6]/60 text-bone",
						effect.status === "partial" && "border-line text-fog",
						effect.status === "coming" && "border-transparent text-[#5c5c64]",
					)}
				>
					{STATUS_LABEL[effect.status]}
				</span>
			</div>
			<p className="text-fog text-[0.68rem] leading-snug">{effect.note}</p>
			{usable && (
				<button
					type="button"
					className="rc-mono self-start cursor-pointer text-[0.66rem] text-bone underline decoration-[#5c5c64] underline-offset-2 hover:decoration-bone"
					onClick={() => onUse(effect)}
				>
					{effect.via?.kind === "shader" ? "add at playhead" : "open"}
				</button>
			)}
			{effect.via?.kind === "editor" && (
				<span className="rc-mono text-[0.62rem] text-fog">{effect.via.where}</span>
			)}
		</div>
	);
}
