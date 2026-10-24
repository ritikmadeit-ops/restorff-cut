/** Inspector header when no single clip is selected (artboard: "SELECTED · ..."). */
export function EmptyView({ count = 0 }: { count?: number }) {
	return (
		<section className="flex flex-col gap-3.5 px-[18px] pt-[18px]">
			<h2 className="rc-label">
				{count > 1 ? `Selected · ${count} clips` : "Selected · none"}
			</h2>
			<p className="text-fog text-[0.9rem] leading-relaxed">
				{count > 1
					? "Several clips are selected. Pick one to see its settings."
					: "Pick a clip on the timeline to see its settings here."}
			</p>
		</section>
	);
}
