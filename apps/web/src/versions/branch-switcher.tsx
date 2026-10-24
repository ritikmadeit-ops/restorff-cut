"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { syncEngine } from "@/sync/engine";
import { useSyncStore } from "@/sync/store";

const NEW = "__new__";

/** Branch switch + create (ported idea: OpenCut-AI branch-switcher). */
export function BranchSwitcher() {
	const branch = useSyncStore((s) => s.branch);
	const branches = useSyncStore((s) => s.branches);
	const status = useSyncStore((s) => s.status);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");

	const all = branches.includes(branch) ? branches : [branch, ...branches];

	const onChange = async (value: string) => {
		if (value === NEW) {
			setCreating(true);
			return;
		}
		if (value === branch) return;
		if (status === "dirty" && !window.confirm("Switching drops edits not yet committed. Switch anyway?")) {
			return;
		}
		try {
			await syncEngine.switchBranch(value);
			toast(`On ${value}`);
		} catch (error) {
			toast.error("Could not switch branch", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const create = async () => {
		const clean = name.trim().replace(/\s+/g, "-");
		if (!clean) return;
		try {
			await syncEngine.createBranch(clean);
			toast(`Branch ${clean} created`, { description: "New commits go there; main is untouched." });
			setCreating(false);
			setName("");
		} catch (error) {
			toast.error("Could not create the branch", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	if (creating) {
		return (
			<form
				className="flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void create();
				}}
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: the field opens on an explicit "new branch" pick
					autoFocus
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="alt-hook"
					aria-label="New branch name"
					className="rc-mono bg-ground border-line h-8 w-36 rounded-md border px-2 text-xs text-bone outline-none focus:border-fog"
				/>
				<button type="submit" className="rc-mono text-bone text-xs">
					create
				</button>
				<button type="button" className="rc-mono text-fog text-xs" onClick={() => setCreating(false)}>
					cancel
				</button>
			</form>
		);
	}

	return (
		<Select value={branch} onValueChange={(v) => void onChange(v)}>
			<SelectTrigger className="rc-mono h-8 w-44 text-xs" aria-label="Branch">
				<SelectValue />
			</SelectTrigger>
			<SelectContent className="z-300">
				{all.map((b) => (
					<SelectItem key={b} value={b} className="rc-mono text-xs">
						{b}
					</SelectItem>
				))}
				<SelectItem value={NEW} className="rc-mono text-fog text-xs">
					+ new branch from here
				</SelectItem>
			</SelectContent>
		</Select>
	);
}
