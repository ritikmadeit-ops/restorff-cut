"use client";

/**
 * Watches the sync engine for commits made by someone other than this browser (Claude over MCP, a preset, the
 * compiler) and keeps a before/after of each: "before" is drawn the moment a pull starts (the editor still holds
 * the old cut), "after" once the pulled snapshot is loaded.
 */
import { useEffect, useRef, useState } from "react";
import type { EditorCore } from "@/core";
import type { RemoteCommit } from "@/sync/remote";
import { useSyncStore } from "@/sync/store";
import { captureFrame } from "./frame";

export interface RemoteCommitView {
	commit: RemoteCommit;
	count: number;
	before: string | null;
	after: string | null;
	at: number;
}

const AFTER_LOAD_DELAY_MS = 900;

export function useRemoteCommits(editor: EditorCore): { latest: RemoteCommitView | null; dismiss: () => void } {
	const [latest, setLatest] = useState<RemoteCommitView | null>(null);
	const beforeRef = useRef<Promise<string | null> | null>(null);

	useEffect(() => {
		const unsubscribe = useSyncStore.subscribe((state, prev) => {
			if (state.status === "pulling" && prev.status !== "pulling") {
				beforeRef.current = captureFrame({ editor });
			}
			const pulled = state.pulled;
			if (!pulled || pulled === prev.pulled || pulled.commit.author === "user") return;
			const before = beforeRef.current;
			beforeRef.current = null;
			setTimeout(async () => {
				const [beforeUrl, afterUrl] = await Promise.all([before ?? Promise.resolve(null), captureFrame({ editor })]);
				setLatest({ commit: pulled.commit, count: pulled.count, before: beforeUrl, after: afterUrl, at: pulled.at });
			}, AFTER_LOAD_DELAY_MS);
		});
		return unsubscribe;
	}, [editor]);

	return { latest, dismiss: () => setLatest(null) };
}
