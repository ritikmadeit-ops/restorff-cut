"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { useEditor } from "@/editor/use-editor";
import { useFileUpload } from "@/media/use-file-upload";
import { invokeAction } from "@/actions";
import { processMediaAssets } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import {
	SelectableItem,
	SelectableSurface,
	useSelection,
	useSelectionScope,
} from "@/selection";
import { buildElementFromMedia } from "@/timeline/element-utils";
import {
	type MediaSortKey,
	type MediaSortOrder,
	type MediaViewMode,
	useAssetsPanelStore,
} from "@/components/editor/panels/assets/assets-panel-store";
import { MASKABLE_ELEMENT_TYPES } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { cn } from "@/utils/ui";
import { shotLabel, stripExtension } from "@/storyboard/labels";
import {
	CloudUploadIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
	SortingOneNineIcon,
	Image02Icon,
	MusicNote03Icon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function MediaView() {
	const editor = useEditor();
	const mediaFiles = useEditor((e) => e.media.getAssets());
	const activeProject = useEditor((e) => e.project.getActive());

	const {
		mediaViewMode,
		setMediaViewMode,
		highlightMediaId,
		clearHighlight,
		mediaSortBy,
		mediaSortOrder,
		setMediaSort,
	} = useAssetsPanelStore();

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);

	const processFiles = async ({ files }: { files: File[] }) => {
		if (!files || files.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		try {
			await showMediaUploadToast({
				filesCount: files.length,
				promise: async () => {
					const processedAssets = await processMediaAssets({
						files,
						onProgress: (progress: { progress: number }) =>
							setProgress(progress.progress),
					});
					for (const asset of processedAssets) {
						await editor.media.addMediaAsset({
							projectId: activeProject.metadata.id,
							asset,
						});
					}
					return {
						uploadedCount: processedAssets.length,
						assetNames: processedAssets.map((asset) => asset.name),
					};
				},
			});
		} catch (error) {
			console.error("Error processing files:", error);
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const { isDragOver, dragProps, openFilePicker, fileInputProps } =
		useFileUpload({
			accept: "image/*,video/*,audio/*",
			multiple: true,
			onFilesSelected: (files) => processFiles({ files }),
		});

	const handleRemove = ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => {
		event.stopPropagation();

		invokeAction("remove-media-assets", {
			projectId: activeProject.metadata.id,
			assetIds: ids,
		});
	};

	const handleSort = ({ key }: { key: MediaSortKey }) => {
		if (mediaSortBy === key) {
			setMediaSort({
				key,
				order: mediaSortOrder === "asc" ? "desc" : "asc",
			});
		} else {
			setMediaSort({ key, order: "asc" });
		}
	};

	const filteredMediaItems = useMemo(() => {
		const filtered = mediaFiles.filter((item) => !item.ephemeral);

		filtered.sort((a, b) => {
			let valueA: string | number;
			let valueB: string | number;

			switch (mediaSortBy) {
				case "name":
					valueA = a.name.toLowerCase();
					valueB = b.name.toLowerCase();
					break;
				case "type":
					valueA = a.type;
					valueB = b.type;
					break;
				case "duration":
					valueA = a.duration || 0;
					valueB = b.duration || 0;
					break;
				case "size":
					valueA = a.file.size;
					valueB = b.file.size;
					break;
				default:
					return 0;
			}

			if (valueA < valueB) return mediaSortOrder === "asc" ? -1 : 1;
			if (valueA > valueB) return mediaSortOrder === "asc" ? 1 : -1;
			return 0;
		});

		return filtered;
	}, [mediaFiles, mediaSortBy, mediaSortOrder]);
	const orderedMediaIds = useMemo(() => {
		return filteredMediaItems.map((item) => item.id);
	}, [filteredMediaItems]);
	const visualCount = filteredMediaItems.filter(
		(item) => item.type !== "audio",
	).length;

	return (
		<>
			<input {...fileInputProps} />

			<PanelView
				title={`Kept clips · ${visualCount}`}
				actions={
					<MediaActions
						mediaViewMode={mediaViewMode}
						setMediaViewMode={setMediaViewMode}
						isProcessing={isProcessing}
						sortBy={mediaSortBy}
						sortOrder={mediaSortOrder}
						onSort={handleSort}
						onImport={openFilePicker}
					/>
				}
				className={cn(isDragOver && "bg-accent/30")}
				contentClassName="h-full"
				{...dragProps}
			>
				{isDragOver || filteredMediaItems.length === 0 ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						onClick={openFilePicker}
					/>
				) : (
					<SelectableSurface
						ariaLabel="Assets"
						orderedIds={orderedMediaIds}
						revealId={highlightMediaId}
						onRevealComplete={clearHighlight}
					>
						<MediaScopeRegistrar />
						<MediaItemList
							items={filteredMediaItems}
							mode={mediaViewMode}
							onRemove={handleRemove}
						/>
					</SelectableSurface>
				)}
			</PanelView>
		</>
	);
}

function MediaScopeRegistrar() {
	useSelectionScope();
	return null;
}

function MediaAssetDraggable({
	item,
	preview,
	variant,
	isRounded,
	label,
	aspectRatio,
	containerClassName,
}: {
	item: MediaAsset;
	preview: React.ReactNode;
	variant: "card" | "compact" | "inline";
	isRounded?: boolean;
	label?: string;
	aspectRatio?: number;
	containerClassName?: string;
}) {
	const editor = useEditor();

	const addElementAtTime = ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: MediaTime;
	}) => {
		const duration =
			asset.duration != null
				? mediaTimeFromSeconds({ seconds: asset.duration })
				: DEFAULT_NEW_ELEMENT_DURATION;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<DraggableItem
			name={label ?? item.name}
			preview={preview}
			aspectRatio={aspectRatio}
			containerClassName={containerClassName}
			dragData={{
				id: item.id,
				type: "media",
				mediaType: item.type,
				name: item.name,
				...(item.type !== "audio" && {
					targetElementTypes: [...MASKABLE_ELEMENT_TYPES],
				}),
			}}
			shouldShowPlusOnDrag={false}
			onAddToTimeline={({ currentTime }) =>
				addElementAtTime({ asset: item, startTime: currentTime })
			}
			variant={variant}
			isRounded={isRounded}
		/>
	);
}

function MediaItemWithContextMenu({
	item,
	children,
	onRemove,
}: {
	item: MediaAsset;
	children: React.ReactNode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
}) {
	const { isSelected, selectedIds } = useSelection();
	const idsToDelete = isSelected(item.id) ? selectedIds : [item.id];
	const deleteLabel =
		idsToDelete.length > 1 ? `Delete ${idsToDelete.length} items` : "Delete";

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem>Export clips</ContextMenuItem>
				<ContextMenuItem
					variant="destructive"
					onClick={(event: React.MouseEvent<HTMLDivElement>) =>
						onRemove({ event, ids: idsToDelete })
					}
				>
					{deleteLabel}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function MediaItemList({
	items,
	mode,
	onRemove,
}: {
	items: MediaAsset[];
	mode: MediaViewMode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
}) {
	const isGrid = mode === "grid";

	if (!isGrid) {
		return (
			<div className="flex flex-col gap-1.5">
				{items.map((item) => (
					<MediaListItem
						key={item.id}
						item={item}
						onRemove={onRemove}
						variant="compact"
					/>
				))}
			</div>
		);
	}

	return <KeptClipsGrid items={items} onRemove={onRemove} />;
}

/**
 * The artboard's left column, measured from its DOM: a 3-column grid of 9:16
 * tiles (gap 8, radius 6) labelled with shot keys in mono 10 px #A6A6AE, then
 * "AUDIO" (mono label, 8 px extra space) with one 13 px line per music/voice
 * file ("morning-bed · 31 s") and the short effects on one shared line
 * ("kettle_click · pour_soft · bottle_tap").
 */
function KeptClipsGrid({
	items,
	onRemove,
}: {
	items: MediaAsset[];
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
}) {
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const visualItems = items.filter((item) => item.type !== "audio");
	const audioItems = items.filter((item) => item.type === "audio");

	const sfxMediaIds = useMemo(() => {
		const ids = new Set<string>();
		for (const track of scene?.tracks.audio ?? []) {
			const role = (track as { restorff?: { role?: string } }).restorff?.role;
			if (role !== "sfx" && !track.name.toUpperCase().startsWith("SFX")) continue;
			for (const element of track.elements) {
				if (element.sourceType === "upload") ids.add(element.mediaId);
			}
		}
		return ids;
	}, [scene]);

	const isSfx = (item: MediaAsset) =>
		sfxMediaIds.has(item.id) ||
		(item.duration !== undefined && item.duration > 0 && item.duration <= SFX_MAX_SECONDS);
	const beds = audioItems.filter((item) => !isSfx(item));
	const sfx = audioItems.filter(isSfx);

	return (
		<div className="flex flex-col gap-3 pb-4">
			{visualItems.length > 0 && (
				<div className="grid grid-cols-3 gap-2">
					{visualItems.map((item) => (
						<MediaListItem
							key={item.id}
							item={item}
							onRemove={onRemove}
							variant="card"
						/>
					))}
				</div>
			)}
			{audioItems.length > 0 && (
				<>
					<h3 className="rc-label mt-2">Audio</h3>
					{beds.map((item) => (
						<MediaListItem
							key={item.id}
							item={item}
							onRemove={onRemove}
							variant="audio-line"
						/>
					))}
					{sfx.length > 0 && (
						// ui-fix-panels (QA #26): a div, not a <p> — MediaListItem renders divs (hydration error)
						<div className="flex flex-wrap items-baseline gap-x-[0.35em] text-[13px] leading-[18px] text-bone">
							{sfx.map((item, index) => (
								<span key={item.id} className="inline-flex items-baseline gap-x-[0.35em]">
									{index > 0 && <span aria-hidden>·</span>}
									<MediaListItem item={item} onRemove={onRemove} variant="inline" />
								</span>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** Audio this short is a sound effect (listed on the shared SFX line). */
const SFX_MAX_SECONDS = 3;

function MediaListItem({
	item,
	onRemove,
	variant,
}: {
	item: MediaAsset;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
	variant: "card" | "compact" | "audio-line" | "inline";
}) {
	const isCard = variant === "card";
	const isBare = variant === "audio-line" || variant === "inline";
	const durationLabel =
		(variant === "compact" || variant === "audio-line") && item.duration
			? ` · ${Math.round(item.duration)} s`
			: "";
	// Labels read like the artboard: tiles carry the shot key ("S01"), audio its
	// name without extension ("morning-bed · 31 s").
	const displayName = isCard ? shotLabel(item.name) : stripExtension(item.name);
	return (
		<MediaItemWithContextMenu item={item} onRemove={onRemove}>
			<SelectableItem
				className={cn(variant === "inline" ? "inline-flex w-auto" : !isCard && "w-full")}
				id={item.id}
			>
				<MediaAssetDraggable
					item={item}
					label={`${displayName}${durationLabel}`}
					preview={
						isBare ? null : (
							<MediaPreview item={item} variant={isCard ? "grid" : "compact"} />
						)
					}
					variant={variant === "audio-line" ? "compact" : variant}
					aspectRatio={isCard ? 9 / 16 : undefined}
					containerClassName={isCard ? "w-full" : undefined}
				/>
			</SelectableItem>
		</MediaItemWithContextMenu>
	);
}

function formatDuration({ duration }: { duration: number }) {
	const min = Math.floor(duration / 60);
	const sec = Math.floor(duration % 60);
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MediaDurationBadge({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<div className="rc-mono absolute right-1 bottom-1 rounded-full bg-black/70 px-1.5 text-[0.6rem] text-bone">
			{formatDuration({ duration })}
		</div>
	);
}

function MediaDurationLabel({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<span className="text-xs opacity-70">{formatDuration({ duration })}</span>
	);
}

function MediaTypePlaceholder({
	icon,
	label,
	duration,
	variant,
}: {
	icon: IconSvgElement;
	label: string;
	duration?: number;
	variant: "muted" | "bordered";
}) {
	const iconClassName = cn("size-6", variant === "bordered" && "mb-1");

	return (
		<div
			className={cn(
				"text-muted-foreground flex size-full flex-col items-center justify-center rounded",
				variant === "muted" ? "bg-muted/30" : "border",
			)}
		>
			<HugeiconsIcon icon={icon} className={iconClassName} />
			<span className="text-xs">{label}</span>
			<MediaDurationLabel duration={duration} />
		</div>
	);
}

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	// The artboard's tiles carry no badge; the duration is in the tile's tooltip.
	const shouldShowDurationBadge = false;

	if (item.type === "image") {
		return (
			<div className="relative flex size-full items-center justify-center bg-muted">
				<Image
					src={item.url ?? ""}
					alt={item.name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
				/>
			</div>
		);
	}

	if (item.type === "video") {
		if (item.thumbnailUrl) {
			return (
				<div className="relative size-full">
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="100vw"
						className="object-cover"
						loading="lazy"
						unoptimized
					/>
					{shouldShowDurationBadge ? (
						<MediaDurationBadge duration={item.duration} />
					) : null}
				</div>
			);
		}

		return (
			<MediaTypePlaceholder
				icon={Video01Icon}
				label="Video"
				duration={item.duration}
				variant="muted"
			/>
		);
	}

	if (item.type === "audio" && variant === "compact") {
		return (
			<div className="text-fog flex size-full items-center justify-center">
				<HugeiconsIcon icon={MusicNote03Icon} className="size-4" />
			</div>
		);
	}

	if (item.type === "audio") {
		return (
			<MediaTypePlaceholder
				icon={MusicNote03Icon}
				label="Audio"
				duration={item.duration}
				variant="bordered"
			/>
		);
	}

	return (
		<MediaTypePlaceholder icon={Image02Icon} label="Unknown" variant="muted" />
	);
}

function MediaActions({
	mediaViewMode,
	setMediaViewMode,
	isProcessing,
	sortBy,
	sortOrder,
	onSort,
	onImport,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
	onImport: () => void;
}) {
	return (
		<div className="text-fog flex shrink-0 gap-0.5 [&_button]:size-6">
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={() =>
								setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
							}
							disabled={isProcessing}
							className="items-center justify-center"
							aria-label={mediaViewMode === "grid" ? "Switch to list view" : "Switch to grid view" /* ui-fix-panels (QA #27) */}
						>
							{mediaViewMode === "grid" ? (
								<HugeiconsIcon icon={LeftToRightListDashIcon} />
							) : (
								<HugeiconsIcon icon={GridViewIcon} />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>
							{mediaViewMode === "grid"
								? "Switch to list view"
								: "Switch to grid view"}
						</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<DropdownMenu>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									disabled={isProcessing}
									className="items-center justify-center"
									aria-label="Sort clips"
								>
									<HugeiconsIcon icon={SortingOneNineIcon} />
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<DropdownMenuContent align="end">
							<SortMenuItem
								label="Name"
								sortKey="name"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Type"
								sortKey="type"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Duration"
								sortKey="duration"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="File size"
								sortKey="size"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
					<TooltipContent>
						<p>
							Sort by {sortBy} (
							{sortOrder === "asc" ? "ascending" : "descending"})
						</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<Button
				variant="ghost"
				size="icon"
				onClick={onImport}
				disabled={isProcessing}
				aria-label="Import"
				title="Import clips"
				className="items-center justify-center"
			>
				<HugeiconsIcon icon={CloudUploadIcon} />
			</Button>
		</div>
	);
}

function SortMenuItem({
	label,
	sortKey,
	currentSortBy,
	currentSortOrder,
	onSort,
}: {
	label: string;
	sortKey: MediaSortKey;
	currentSortBy: MediaSortKey;
	currentSortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
}) {
	const isActive = currentSortBy === sortKey;
	const arrow = isActive ? (currentSortOrder === "asc" ? "↑" : "↓") : "";

	return (
		<DropdownMenuItem onClick={() => onSort({ key: sortKey })}>
			{label} {arrow}
		</DropdownMenuItem>
	);
}
