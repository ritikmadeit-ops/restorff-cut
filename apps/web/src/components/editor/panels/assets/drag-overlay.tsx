import { HugeiconsIcon } from "@hugeicons/react";
import { UploadIcon } from "@hugeicons/core-free-icons";

interface MediaDragOverlayProps {
	isVisible: boolean;
	isProcessing?: boolean;
	progress?: number;
	onClick?: () => void;
}

export function MediaDragOverlay({
	isVisible,
	isProcessing = false,
	progress = 0,
	onClick,
}: MediaDragOverlayProps) {
	if (!isVisible) return null;

	const handleClick = ({
		event,
	}: {
		event: React.MouseEvent<HTMLButtonElement>;
	}) => {
		if (isProcessing || !onClick) return;
		event.preventDefault();
		event.stopPropagation();
		onClick();
	};

	return (
		<button
			className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-[#3a3a42] p-6 text-center transition-colors hover:border-fog hover:bg-surface"
			type="button"
			disabled={isProcessing || !onClick}
			onClick={(event) => handleClick({ event })}
		>
			<div className="flex items-center justify-center">
				<HugeiconsIcon icon={UploadIcon} className="text-fog size-7" />
			</div>

			<div className="space-y-2">
				<p className="text-bone max-w-sm text-[0.85rem]">
					{isProcessing ? "Importing" : "Drop clips here"}
				</p>
				<p className="rc-mono text-fog max-w-sm text-[0.68rem]">
					{isProcessing
						? `${progress} %`
						: "video · photo · audio — or click to pick"}
				</p>
			</div>

			{isProcessing && (
				<div className="w-full max-w-xs">
					<div className="bg-muted/50 h-2 w-full rounded-full">
						<div
							className="bg-bone h-2 rounded-full"
							style={{ width: `${progress}%` }}
						/>
					</div>
				</div>
			)}
		</button>
	);
}
