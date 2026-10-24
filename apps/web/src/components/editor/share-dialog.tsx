"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { syncEngine } from "@/sync/engine";
import { remote, type RemoteShareLink } from "@/sync/remote";
import { formatTimecode } from "@/sync/snapshot";
import { useSyncStore } from "@/sync/store";
import { cn } from "@/utils/ui";

type Expiry = "1h" | "24h" | "7d" | "30d" | "never";

/**
 * "Share with an editor" (design/edit-artboard.png). Makes two links:
 *  - a review link (/shared/<token>): read-only player with comments anchored
 *    on the timeline, no account needed;
 *  - the editor link (/editor/<id>): opens this project from the server; the
 *    editor's saves come back here as commits.
 * Ported from OpenCut-AI's share dialog (MIT, see NOTICE): expiring
 * unguessable links pinned to a commit, comment triage. Restyled to the skin.
 */
export function ShareWithEditorButton() {
	const [open, setOpen] = useState(false);

	return (
		<>
			<button type="button" className="rc-pill" onClick={() => setOpen(true)}>
				Share with an editor
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				{/* ui-fix-panels (QA #12): one column that can shrink, so a long link truncates instead of widening the card */}
				<DialogContent className="max-w-lg grid-cols-[minmax(0,1fr)] overflow-hidden">
					{open && <ShareBody />}
				</DialogContent>
			</Dialog>
		</>
	);
}

function ShareBody() {
	const status = useSyncStore((s) => s.status);
	const projectId = useSyncStore((s) => s.projectId);
	const head = useSyncStore((s) => s.head);
	const comments = useSyncStore((s) => s.comments);
	const [pin, setPin] = useState(false);
	const [canComment, setCanComment] = useState(true);
	const [expiry, setExpiry] = useState<Expiry>("7d");
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState<{ url: string; editorUrl: string; id: string } | null>(null);
	const createdId = created?.id ?? null;
	const [links, setLinks] = useState<RemoteShareLink[]>([]);

	const linked = status !== "unlinked" && status !== "checking" && status !== "off";

	// ui-fix-panels (QA #12): read the link state when called, not when rendered — a local draft links inside create(),
	// and the old closure (linked=false) skipped the list, so "revoke it below" pointed at nothing
	const loadLinks = useCallback(async () => {
		const state = useSyncStore.getState();
		const isLinked = state.status !== "unlinked" && state.status !== "checking" && state.status !== "off";
		if (!projectId || !isLinked) return;
		try {
			setLinks((await remote.listShares(projectId)).links);
		} catch {
			setLinks([]);
		}
	}, [projectId]);

	useEffect(() => {
		void loadLinks();
	}, [loadLinks, linked]);

	const create = async () => {
		if (!projectId) return;
		setCreating(true);
		try {
			if (!linked && !(await syncEngine.link())) return;
			if (useSyncStore.getState().status === "dirty") await syncEngine.push();
			// The review player and a remote editor need the footage, not just the timeline.
			await syncEngine.uploadMissingMedia();
			const pinTo = pin ? useSyncStore.getState().head?.id : undefined;
			const result = await remote.createShare({
				project_id: projectId,
				commit_id: pinTo,
				can_comment: canComment,
				expires_in: expiry,
			});
			setCreated({ url: result.url, editorUrl: result.editor_url, id: result.link.id });
			await loadLinks();
		} catch (error) {
			toast.error("Could not create the link", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setCreating(false);
		}
	};

	const [revoking, setRevoking] = useState<string | null>(null);
	const revoke = async (id: string) => {
		setRevoking(id);
		try {
			await remote.revokeShare(id);
			await loadLinks();
			if (created && createdId === id) setCreated(null);
			toast("Link revoked: it no longer opens");
		} catch (error) {
			toast.error("Could not revoke the link", { description: error instanceof Error ? error.message : String(error) });
		} finally {
			setRevoking(null);
		}
	};

	const open = comments.filter((c) => c.status === "open" && !c.parent_id);

	return (
		<>
			<DialogHeader>
				<span className="rc-label">Share · {linked && head ? `commit ${head.id.slice(0, 7)}` : "local draft"}</span>
				<DialogTitle className="text-xl font-bold">Share with an editor</DialogTitle>
				<DialogDescription>
					A review link opens this cut read-only, with comments pinned to the
					timeline. The editor link opens it in RestorffCut; their saves come
					back as commits.
				</DialogDescription>
			</DialogHeader>
			<DialogBody className="flex min-w-0 flex-col gap-5 text-sm text-[#C9C7C2] [&>*]:min-w-0">
				{!linked && (
					<p className="rc-mono text-fog text-xs">
						This cut has no server copy yet. Creating a link starts its version history.
					</p>
				)}

				<div className="grid grid-cols-2 gap-4">
					<label className="flex flex-col gap-1.5">
						<span className="rc-label">Expires</span>
						<Select value={expiry} onValueChange={(v) => setExpiry(v as Expiry)}>
							<SelectTrigger className="rc-mono h-9 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent className="z-300">
								<SelectItem value="1h">1 hour</SelectItem>
								<SelectItem value="24h">24 hours</SelectItem>
								<SelectItem value="7d">7 days</SelectItem>
								<SelectItem value="30d">30 days</SelectItem>
								<SelectItem value="never">never</SelectItem>
							</SelectContent>
						</Select>
					</label>
					<div className="flex flex-col gap-3 pt-1">
						<ToggleRow label="Comments" checked={canComment} onChange={setCanComment} />
						<ToggleRow label="Pin this commit" checked={pin} onChange={setPin} />
					</div>
				</div>
				<p className="rc-mono text-fog -mt-2 text-[0.6875rem]">
					{pin ? "reviewers see this exact commit" : "reviewers always see the latest commit on main"}
				</p>

				<button type="button" className="rc-pill self-start" onClick={create} disabled={creating}>
					{creating ? "Uploading media and making the link…" : "Create review link"}
				</button>

				{created && (
					<div className="flex flex-col gap-3">
						<LinkRow label="Review link" url={created.url} />
						<LinkRow label="Editor link" url={created.editorUrl} />
						<p className="rc-mono text-fog text-[0.6875rem]">
							the review link is shown once; to cut access, revoke it in the list below
						</p>
					</div>
				)}

				{linked && (
					<div className="flex flex-col gap-2">
						<span className="rc-label">
							Review links · {links.filter((l) => !l.revoked).length} active
						</span>
						{links.length === 0 ? (
							<p className="rc-mono text-fog text-[0.6875rem]">no links yet</p>
						) : (
							<ul className="flex max-h-48 flex-col overflow-y-auto">
								{[...links]
									.sort((a, b) => Number(a.revoked) - Number(b.revoked))
									.slice(0, 12)
									.map((link) => (
										<li
											key={link.id}
											className={cn(
												"border-line/60 flex min-w-0 items-center gap-3 border-b py-2 text-[0.75rem]",
												link.revoked && "opacity-50",
											)}
										>
											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<span className="text-bone truncate">
													{link.id === createdId ? "This link · " : ""}
													{link.pinned ? `pinned to ${link.commit_id?.slice(0, 7)}` : `follows ${link.branch}`}
												</span>
												<span className="rc-mono text-fog truncate text-[0.66rem]">
													{link.can_comment ? "comments" : "view only"} · {link.view_count} view{link.view_count === 1 ? "" : "s"} ·{" "}
													{link.revoked ? "revoked" : link.expires_at ? `until ${link.expires_at.slice(0, 10)}` : "no expiry"}
												</span>
											</div>
											{!link.revoked && (
												<button
													type="button"
													className="rc-pill h-7 shrink-0 px-2.5 text-[0.72rem]"
													disabled={revoking === link.id}
													aria-label={`Revoke the review link that ${link.pinned ? `is pinned to ${link.commit_id?.slice(0, 7)}` : `follows ${link.branch}`}`}
													onClick={() => void revoke(link.id)}
												>
													{revoking === link.id ? "Revoking…" : "Revoke"}
												</button>
											)}
										</li>
									))}
							</ul>
						)}
					</div>
				)}

				{open.length > 0 && (
					<div className="flex flex-col gap-2">
						<span className="rc-label">Open comments · {open.length}</span>
						<ul className="flex max-h-40 flex-col overflow-y-auto">
							{open.slice(0, 20).map((c) => (
								<li key={c.id} className="border-line/60 flex items-baseline gap-2 border-b py-1.5 text-xs">
									<span className="rc-mono text-fog shrink-0">
										{c.rule_id ? `${c.rule_id} · ` : ""}
										{formatTimecode(c.time_s)}
									</span>
									<span className="min-w-0 flex-1 truncate">{c.body}</span>
									<button
										type="button"
										className="rc-mono text-fog hover:text-bone shrink-0 text-[0.6875rem]"
										onClick={async () => {
											if (!projectId) return;
											await remote.updateComment(projectId, c.id, { status: "resolved" });
											await syncEngine.loadComments();
										}}
									>
										resolve
									</button>
								</li>
							))}
						</ul>
					</div>
				)}
			</DialogBody>
		</>
	);
}

function ToggleRow({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<span className="flex items-center justify-between gap-3">
			<span className="rc-label">{label}</span>
			<Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
		</span>
	);
}

function LinkRow({ label, url }: { label: string; url: string }) {
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast(`${label} copied`);
		} catch {
			toast.error("Copy failed: select the link and copy it");
		}
	};
	return (
		<div className="flex flex-col gap-1">
			<span className="rc-label">{label}</span>
			<div className="bg-ground border-line flex items-center gap-2 rounded-xl border px-3 py-2">
				<code className="rc-mono text-bone min-w-0 flex-1 truncate text-xs" title={url}>
					{url}
				</code>
				<button type="button" className="rc-mono text-fog hover:text-bone shrink-0 text-xs" onClick={copy}>
					copy
				</button>
			</div>
		</div>
	);
}
