import { cn } from "@/utils/ui";

interface PanelViewProps extends React.HTMLAttributes<HTMLDivElement> {
	title?: string;
	actions?: React.ReactNode;
	children: React.ReactNode;
	contentClassName?: string;
	scrollClassName?: string;
	hideHeader?: boolean;
	ref?: React.Ref<HTMLDivElement>;
	onScroll?: React.UIEventHandler<HTMLDivElement>;
	scrollRef?: React.Ref<HTMLDivElement>;
}

export function PanelView({
	title,
	actions,
	children,
	className,
	contentClassName,
	scrollClassName,
	hideHeader = false,
	ref,
	onScroll,
	scrollRef,
	...rest
}: PanelViewProps) {
	return (
		<div
			className={cn("relative flex h-full flex-col", className)}
			ref={ref}
			{...rest}
		>
			{!hideHeader && (
				// Artboard aside: padding 18, label then content 12 px below.
				// Actions appear on hover so the label ("KEPT CLIPS · 30") never truncates.
				<div className="group/panelhead bg-background flex h-[2.875rem] shrink-0 items-end justify-between gap-1 pr-2 pb-1 pl-[18px]">
					{title && <h2 className="rc-label shrink-0 whitespace-nowrap">{title}</h2>}
					{actions && (
						<div className="flex min-w-0 justify-end overflow-hidden opacity-0 transition-opacity group-hover/panelhead:opacity-100 focus-within:opacity-100">
							{actions}
						</div>
					)}
				</div>
			)}
			<div
				className={cn(
					"scrollbar-hidden size-full overflow-y-auto",
					hideHeader ? "pt-[18px]" : "pt-2",
					scrollClassName,
				)}
				ref={scrollRef}
				onScroll={onScroll}
			>
				<div className={cn("w-full flex-1 px-[18px] pt-0", contentClassName)}>
					{children}
				</div>
			</div>
		</div>
	);
}
