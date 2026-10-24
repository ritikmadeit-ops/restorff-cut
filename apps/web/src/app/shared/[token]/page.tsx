"use client";

import { use, useEffect, useState } from "react";
import { Wordmark } from "@/components/wordmark";
import { ReviewPlayer, type ReviewComment } from "@/review/review-player";
import type { ProjectSnapshot } from "@/sync/snapshot";

interface SharedPayload {
	link: {
		project_name: string;
		pinned: boolean;
		branch: string;
		can_comment: boolean;
		expires_at: string | null;
	};
	commit: { id: string; message: string; author: string; created_at: string | null };
	head: { id: string };
	snapshot: ProjectSnapshot | null;
	comments: ReviewComment[];
	media?: Record<string, { mime: string; size: number }>;
}

type LoadState =
	| { status: "loading" }
	| { status: "ready"; payload: SharedProjectWithSnapshot }
	| { status: "gone" }
	| { status: "error"; message: string };

type SharedProjectWithSnapshot = SharedPayload & { snapshot: ProjectSnapshot };

/**
 * /shared/<token>: the read-only review of a shared cut (ported from OpenCut-AI's
 * shared page, MIT, see NOTICE). No account needed; the token is the credential.
 */
export default function SharedReviewPage({ params }: { params: Promise<{ token: string }> }) {
	const { token } = use(params);
	const [state, setState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/share/${token}?view=1`, { cache: "no-store" });
				if (cancelled) return;
				if (res.status === 404) return setState({ status: "gone" });
				if (!res.ok) return setState({ status: "error", message: `This link could not be loaded (${res.status}).` });
				const payload = (await res.json()) as SharedPayload;
				if (!payload.snapshot) return setState({ status: "error", message: "This commit has no snapshot." });
				setState({ status: "ready", payload: payload as SharedProjectWithSnapshot });
			} catch {
				if (!cancelled) setState({ status: "error", message: "Network error. Try again." });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [token]);

	const payload = state.status === "ready" ? state.payload : null;

	return (
		<main className="bg-background text-foreground flex h-dvh flex-col overflow-hidden">
			<header className="border-line flex h-[4.25rem] shrink-0 items-center gap-6 border-b px-6">
				<Wordmark />
				<span className="rc-mono min-w-0 truncate text-[0.8125rem] text-[#C9C7C2]">
					review · {payload?.link.project_name ?? "shared cut"}
				</span>
				{payload && (
					<span className="rc-mono ml-auto shrink-0 truncate text-[0.8125rem] text-[#C9C7C2]">
						commit {payload.commit.id.slice(0, 7)} · {payload.commit.message} ·{" "}
						{payload.link.pinned ? "pinned" : `latest on ${payload.link.branch}`} · read-only
					</span>
				)}
			</header>

			{state.status === "loading" && <Centered>loading the cut…</Centered>}
			{state.status === "gone" && (
				<Centered>
					<span className="text-bone block text-lg font-bold">Link not found</span>
					<span className="mt-2 block">It was revoked or has expired. Ask for a fresh link.</span>
				</Centered>
			)}
			{state.status === "error" && <Centered>{state.message}</Centered>}
			{payload && (
				<ReviewPlayer
					token={token}
					projectName={payload.link.project_name}
					snapshot={payload.snapshot}
					commitId={payload.commit.id}
					canComment={payload.link.can_comment}
					initialComments={payload.comments}
					media={payload.media}
				/>
			)}
		</main>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="rc-mono text-fog flex flex-1 flex-col items-center justify-center px-6 text-center text-sm">
			{children}
		</div>
	);
}
