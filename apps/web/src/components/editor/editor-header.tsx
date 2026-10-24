"use client";

import { useRef, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { RenameProjectDialog } from "@/project/components/rename-project-dialog";
import { DeleteProjectDialog } from "@/project/components/delete-project-dialog";
import { useRouter } from "next/navigation";
import { ExportButton } from "./export-button";
import { ShareWithEditorButton } from "./share-dialog";
import { CommitLine } from "./commit-line";
import { Wordmark } from "../wordmark";
import { PARENT_PRODUCT_NAME } from "@/site/brand";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import {
	CommandIcon,
	Delete02Icon,
	Edit03Icon,
	Logout05Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ShortcutsDialog } from "@/actions/components/shortcuts-dialog";
import { cn } from "@/utils/ui";
import { projectCrumbs } from "@/storyboard/labels";

/**
 * The RestorffCut header, measured from the Edit artboard's DOM (design canvas
 * "6 · Edit"): padding 14 24, gap 22, hairline #222228; wordmark Archivo
 * expanded 800 18 px tracked .04em; mono 12 px #A6A6AE breadcrumb
 * "in Restorff · <brand> / <ad> / Edit"; flexible gap; mono commit line (port
 * agent's CommitLine, only sized here); "Share with an editor" (quiet outline)
 * and "Render final" (bone outline, gate agent's ExportButton).
 */
export function EditorHeader() {
	return (
		<header className="bg-background border-hairline flex min-h-[4.25rem] shrink-0 items-center gap-[22px] border-b px-6 py-3.5">
			<ProjectMenu />
			<Breadcrumb />
			<span className="min-w-0 flex-1" />
			{/* Sized from here; content and behaviour belong to commit-line.tsx (port). */}
			<span className="flex min-w-0 shrink items-center [&>button]:text-[12px] [&>button]:text-mist [&>button]:pr-0">
				<CommitLine />
			</span>
			<ShareWithEditorButton />
			{/* "Render final" is the loud one: bone outline, 700 (rc-pill-strong). */}
			<span className="contents [&_.rc-pill]:border-bone [&_.rc-pill]:font-bold">
				<ExportButton />
			</span>
		</header>
	);
}

function Breadcrumb() {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const name = activeProject?.metadata.name ?? "";
	const restorff = (activeProject?.metadata as { restorff?: unknown } | undefined)?.restorff;
	const crumbs = projectCrumbs(name, restorff);
	// A brand from metadata.restorff that the name doesn't already carry is printed
	// before the (editable) name; a name like "Halcyon Cold Brew / AD-014" reads as is.
	const brandPrefix =
		crumbs.brand && !name.toLowerCase().includes(crumbs.brand.toLowerCase())
			? crumbs.brand
			: null;
	return (
		<div className="rc-mono text-mist flex min-w-0 shrink items-center gap-[0.6ch] text-[12px]">
			<span className="shrink-0">in {PARENT_PRODUCT_NAME}</span>
			<span className="shrink-0">·</span>
			{brandPrefix && (
				<>
					<span className="shrink-0">{brandPrefix}</span>
					<span className="shrink-0">/</span>
				</>
			)}
			<EditableProjectName />
			<span className="shrink-0">/</span>
			<span className="shrink-0">Edit</span>
		</div>
	);
}

function ProjectMenu() {
	const [openDialog, setOpenDialog] = useState<
		"delete" | "rename" | "shortcuts" | null
	>(null);
	const [isExiting, setIsExiting] = useState(false);
	const router = useRouter();
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());

	const handleExit = async () => {
		if (isExiting) return;
		setIsExiting(true);

		try {
			await editor.project.prepareExit();
			editor.project.closeProject();
		} catch (error) {
			console.error("Failed to prepare project exit:", error);
		} finally {
			editor.project.closeProject();
			router.push("/projects");
		}
	};

	const handleSaveProjectName = async (newName: string) => {
		if (
			activeProject &&
			newName.trim() &&
			newName !== activeProject.metadata.name
		) {
			try {
				await editor.project.renameProject({
					id: activeProject.metadata.id,
					name: newName.trim(),
				});
			} catch (error) {
				toast.error("Failed to rename project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			} finally {
				setOpenDialog(null);
			}
		}
	};

	const handleDeleteProject = async () => {
		if (activeProject) {
			try {
				await editor.project.deleteProjects({
					ids: [activeProject.metadata.id],
				});
				router.push("/projects");
			} catch (error) {
				toast.error("Failed to delete project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			} finally {
				setOpenDialog(null);
			}
		}
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="shrink-0 cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
						aria-label="Project menu"
					>
						<Wordmark className="text-[18px] tracking-[0.04em]" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="z-100 w-48">
					<DropdownMenuItem
						onClick={handleExit}
						disabled={isExiting}
						icon={<HugeiconsIcon icon={Logout05Icon} />}
					>
						All projects
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setOpenDialog("rename")}
						icon={<HugeiconsIcon icon={Edit03Icon} />}
					>
						Rename
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setOpenDialog("shortcuts")}
						icon={<HugeiconsIcon icon={CommandIcon} />}
					>
						Shortcuts
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => setOpenDialog("delete")}
						icon={<HugeiconsIcon icon={Delete02Icon} />}
						className="text-destructive"
					>
						Delete project
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<RenameProjectDialog
				isOpen={openDialog === "rename"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "rename" : null)}
				onConfirm={(newName) => handleSaveProjectName(newName)}
				projectName={activeProject?.metadata.name || ""}
			/>
			<DeleteProjectDialog
				isOpen={openDialog === "delete"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "delete" : null)}
				onConfirm={handleDeleteProject}
				projectNames={[activeProject?.metadata.name || ""]}
			/>
			<ShortcutsDialog
				isOpen={openDialog === "shortcuts"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "shortcuts" : null)}
			/>
		</>
	);
}

function EditableProjectName() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const [isEditing, setIsEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const originalNameRef = useRef("");

	const projectName = activeProject?.metadata.name || "";

	const startEditing = () => {
		if (isEditing) return;
		originalNameRef.current = projectName;
		setIsEditing(true);

		requestAnimationFrame(() => {
			inputRef.current?.select();
		});
	};

	const saveEdit = async () => {
		if (!inputRef.current || !activeProject) return;
		const newName = inputRef.current.value.trim();
		setIsEditing(false);

		if (!newName) {
			inputRef.current.value = originalNameRef.current;
			return;
		}

		if (newName !== originalNameRef.current) {
			try {
				await editor.project.renameProject({
					id: activeProject.metadata.id,
					name: newName,
				});
			} catch (error) {
				toast.error("Failed to rename project", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
			}
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			inputRef.current?.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (inputRef.current) {
				inputRef.current.value = originalNameRef.current;
				inputRef.current.setSelectionRange(0, 0);
			}
			setIsEditing(false);
			inputRef.current?.blur();
		}
	};

	return (
		<input
			key={projectName}
			ref={inputRef}
			type="text"
			defaultValue={projectName}
			readOnly={!isEditing}
			onClick={startEditing}
			onBlur={saveEdit}
			onKeyDown={handleKeyDown}
			aria-label="Project name"
			title="Rename project"
			style={{ fieldSizing: "content" }}
			className={cn(
				"rc-mono text-mist min-w-0 max-w-[22rem] truncate rounded-sm bg-transparent px-0.5 py-0.5 text-[12px] outline-none cursor-pointer hover:bg-accent hover:text-bone",
				isEditing && "ring-1 ring-ring cursor-text hover:bg-transparent",
			)}
		/>
	);
}
