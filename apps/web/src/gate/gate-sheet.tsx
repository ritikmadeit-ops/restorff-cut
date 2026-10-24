"use client";

/**
 * The gate sheet (EXPORT-GATE §2 "The gate's state"; looks after design/judge-artboard.png): the verdict big
 * (GATE PASS · BLOCKED · INCOMPLETE), the measured numbers, every finding worst first (rule · timecode · message →
 * fix; click = seek + select), the owner's overrides (D13) and "Download final", which stays disabled while any
 * MUST is open. Docked right so the timeline and its markers stay visible.
 */
import { useEffect, useState } from "react";
import { formatTime, NEVER_OVERRIDE, type Finding, type GateOverride } from "@restorffcut/gate";
import { useEditor } from "@/editor/use-editor";
import { downloadBuffer, getExportMimeType } from "@/export";
import { cn } from "@/utils/ui";
import { currentOwner } from "./owner";
import {
	fixLoudness,
	focusFinding,
	OverrideError,
	projectOverrides,
	recordNotRunOverride,
	recordOverride,
	removeOverride,
	runGate,
} from "./run";
import { downloadServerRender, stopWaitingForServerRender } from "./server-render";
import { isGateBusy, useGateStore } from "./store";

function elapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function megabytes(bytes: number | null | undefined): string {
	return typeof bytes === "number" ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "";
}

const STATE_WORD = {
	PASS: "Gate pass",
	BLOCKED: "Blocked",
	INCOMPLETE: "Incomplete",
} as const;

function fmt(n: number | null | undefined, digits = 1, unit = ""): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "—";
	return `${n.toFixed(digits)}${unit}`;
}

export function GateSheet() {
	const editor = useEditor();
	const s = useGateStore();
	const exportState = useEditor((e) => e.project.getExportState());
	const project = useEditor((e) => e.project.getActiveOrNull());
	const overrides = projectOverrides(project);
	const [overrideFor, setOverrideFor] = useState<string | null>(null);
	const [reason, setReason] = useState("");
	const [formError, setFormError] = useState<string | null>(null);
	const isOpen = s.open;
	const setGate = s.set;
	const busy = isGateBusy(s.phase);
	// ticks once a second while busy, for the elapsed time (ui-fix-render)
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!isOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && overrideFor === null) setGate({ open: false });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isOpen, overrideFor, setGate]);

	useEffect(() => {
		if (!isOpen || !busy) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [isOpen, busy]);

	if (!s.open) return null;

	const report = s.report;
	const onServer = s.where === "server";
	const word = busy
		? s.phase === "preparing"
			? "Preparing"
			: s.phase === "rendering"
				? "Rendering"
				: s.phase === "fixing"
					? "Fixing"
					: "Checking"
		: s.phase === "error"
			? "Render failed"
			: report
				? STATE_WORD[report.state]
				: "Gate";
	// 0..1 for the bar while rendering; null = working, no measurable progress (preparing, checking)
	const progress =
		s.phase === "rendering" ? (onServer ? (s.server?.progress ?? 0) : exportState.progress) : null;
	const hasFile = onServer ? !!s.server : !!s.buffer;
	const canDownload = !busy && report?.state === "PASS" && hasFile && !!s.fileName;
	const blockingCount = report?.blocking.length ?? 0;
	const loud = report?.findings.find((f) => f.rule === "LOUD" && f.status !== "dismissed");
	const lm = s.measures?.loudness;
	const probe = s.measures?.probe;
	const owner = currentOwner();

	const submitOverride = (target: { finding?: Finding; rule?: string }) => {
		try {
			if (target.finding) recordOverride(editor, target.finding, reason);
			else if (target.rule) recordNotRunOverride(editor, target.rule, reason);
			setOverrideFor(null);
			setReason("");
			setFormError(null);
		} catch (error) {
			setFormError(error instanceof OverrideError || error instanceof Error ? error.message : String(error));
		}
	};

	const rerun = () => void runGate(editor, { format: s.format, quality: s.quality, includeAudio: s.includeAudio, where: s.where });
	const renderInBrowser = () =>
		void runGate(editor, { format: s.format, quality: s.quality, includeAudio: s.includeAudio, where: "browser" });

	const overrideForm = (key: string, target: { finding?: Finding; rule?: string }) =>
		overrideFor === key && (
			<div className="mt-2 flex flex-col gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
				<label className="rc-label text-fog" htmlFor={`gate-reason-${key}`}>
					Why it ships anyway · as {owner.label}
				</label>
				<textarea
					id={`gate-reason-${key}`}
					className="bg-surface border-line text-bone min-h-16 rounded-[10px] border p-2 text-sm"
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					placeholder="A written reason, recorded on the project and shown to every judge."
				/>
				{formError && <p className="text-stale text-xs">{formError}</p>}
				<div className="flex gap-2">
					<button type="button" className="rc-pill rc-pill-strong h-8 text-xs" onClick={() => submitOverride(target)}>
						Record override
					</button>
					<button
						type="button"
						className="rc-pill h-8 text-xs"
						onClick={() => {
							setOverrideFor(null);
							setFormError(null);
						}}
					>
						Cancel
					</button>
				</div>
			</div>
		);

	return (
		<aside
			className="bg-ground border-line fixed top-16 right-4 bottom-4 z-50 flex w-[460px] max-w-[calc(100vw-2rem)] flex-col rounded-[18px] border shadow-2xl"
			aria-label="Export gate"
			data-gate-state={report?.state ?? s.phase}
		>
			<header className="border-line flex items-center justify-between border-b px-5 py-3">
				<span className="rc-label text-fog truncate">
					Export gate{s.fileName ? ` · ${s.fileName}` : ""}
				</span>
				<button
					type="button"
					className="rc-mono text-fog hover:text-bone text-xs"
					onClick={() => s.set({ open: false })}
				>
					Esc · close
				</button>
			</header>

			<div className="flex-1 overflow-y-auto px-5 pt-4 pb-3">
				<h2
					className={cn(
						"rc-display text-bone text-[2.6rem] leading-[0.95]",
						report?.state === "PASS" && !busy && "text-bone",
					)}
					data-testid="gate-word"
				>
					{word}
				</h2>
				<p className="rc-mono text-fog mt-2 text-xs" data-testid="gate-status">
					{busy
						? `${s.status ?? (s.phase === "fixing" ? "applying the gain, then rendering and checking again" : "timeline checks + ffmpeg on the encoded file")}${progress !== null ? ` ${Math.round(progress * 100)} %` : ""}${s.startedAt ? ` · ${elapsed(now - s.startedAt)}` : ""}`
						: s.phase === "error"
							? s.error
							: report
								? `${report.counts.must} must · ${report.counts.should} should · ${report.ran.length} checks ran${report.not_run.length ? ` · ${report.not_run.length} did not` : ""}${s.markerMode ? ` · markers ${s.markerMode === "server" ? "on the project" : "local only"}` : ""}`
								: "Render final runs every check before the file can leave."}
				</p>

				{busy && (
					<div
						className="bg-raised mt-3 h-1.5 w-full overflow-hidden rounded-full"
						role="progressbar"
						aria-label={word}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={progress !== null ? Math.round(progress * 100) : undefined}
						data-testid="gate-progress"
					>
						<div
							className={cn("bg-bone h-full rounded-full transition-[width] duration-700", progress === null && "w-1/3 animate-pulse")}
							style={progress !== null ? { width: `${Math.max(2, Math.round(progress * 100))}%` } : undefined}
						/>
					</div>
				)}
				{busy && (
					<p className="rc-mono text-fog mt-2 text-[0.65rem] leading-snug">
						{onServer
							? "Rendering on RestorffCut's server: keep editing, this tab stays free. Edits made now are not in this render."
							: "Rendering in this browser: the tab is busy until the file is encoded."}
					</p>
				)}

				{s.phase === "error" && onServer && (
					<button type="button" className="rc-pill mt-3 h-9 w-full text-xs" onClick={renderInBrowser} data-testid="gate-render-in-browser">
						Render in this browser instead (slow)
					</button>
				)}

				{!busy && onServer && s.server && report && (
					<p className="rc-mono text-fog mt-3 text-[0.7rem] leading-snug" data-testid="gate-server-render">
						{s.server.repeated ? "reused the server render of" : "rendered on the server"}
						{s.server.renderSeconds !== null && !s.server.repeated ? ` in ${s.server.renderSeconds} s` : ""} · commit{" "}
						{s.server.commit.slice(0, 7)}
						{s.server.duration_s !== null ? ` · ${s.server.duration_s.toFixed(1)} s` : ""}
						{s.server.bytes !== null ? ` · ${megabytes(s.server.bytes)}` : ""}
						{s.server.checkSeconds !== null ? ` · checked in ${s.server.checkSeconds} s` : ""}
					</p>
				)}

				{s.measures && (
					<div className="mt-4 grid grid-cols-2 gap-2">
						{[
							[fmt(lm?.integrated_lufs, 1, " LUFS"), "loudness · target −14 ±1"],
							[fmt(lm?.true_peak_dbtp, 1, " dBTP"), "true peak · max −1"],
							[probe ? `${probe.width}x${probe.height}` : "—", "size"],
							[probe ? `${fmt(probe.fps, 2)} fps` : "—", `${probe?.video_codec ?? "?"} + ${probe?.audio_codec ?? "no audio"}`],
							// retention (2026-10-24): HOOK / DEAD's measures; the findings below jump to each stretch
							...(s.measures.retention
								? [
										[s.measures.retention.first_change_s === null ? "never" : fmt(s.measures.retention.first_change_s, 2, " s"), "hook · first change · bar 1.0 s"],
										[fmt(s.measures.retention.longest_still_s, 2, " s"), `longest still · bar 3.0 s${s.measures.retention.still_over_3s ? ` · ${s.measures.retention.still_over_3s} over` : ""}`],
									]
								: []),
						].map(([big, small]) => (
							<div key={small} className="bg-surface border-line rounded-[14px] border px-3 py-2">
								<div className="rc-mono text-bone text-base">{big}</div>
								<div className="text-fog text-[0.7rem]">{small}</div>
							</div>
						))}
					</div>
				)}

				{s.lastFix && (
					<p className="rc-mono text-fog mt-3 text-[0.7rem]">
						Fix loudness applied {s.lastFix.gain_db >= 0 ? "+" : ""}
						{s.lastFix.gain_db.toFixed(1)} dB to {s.lastFix.elements} element{s.lastFix.elements === 1 ? "" : "s"}
						{s.lastFix.limited ? ` (wanted ${s.lastFix.wanted_db.toFixed(1)} dB; capped by the true peak — needs a limiter)` : ""}
						{s.lastFix.clamped ? ` · ${s.lastFix.clamped} hit the +20 dB volume cap` : ""}
					</p>
				)}

				{loud && lm && !busy && (
					<button
						type="button"
						className="rc-pill rc-pill-strong mt-3 w-full"
						onClick={() => void fixLoudness(editor)}
						data-testid="gate-fix-loudness"
					>
						Fix loudness · apply {fmt(loud.measure?.gain_db as number | null, 1, " dB")} and re-check
					</button>
				)}

				{report && (
					<>
						<div className="rc-label text-fog mt-5 mb-2">
							Findings · worst first{report.findings.length ? ` · ${report.findings.length}` : ""}
						</div>
						{report.findings.length === 0 && <p className="text-fog text-sm">No findings.</p>}
						<ol className="flex flex-col gap-1.5">
							{report.findings.map((f) => {
								const dismissed = f.status === "dismissed";
								const isFirstBlocking = report.blocking[0]?.id === f.id;
								const canOverride = f.severity === "must" && !dismissed && !NEVER_OVERRIDE.has(f.rule);
								return (
									<li key={f.id}>
										<div
											role="button"
											tabIndex={0}
											onClick={() => focusFinding(editor, f)}
											onKeyDown={(e) => {
												if (e.key === "Enter") focusFinding(editor, f);
											}}
											className={cn(
												"bg-surface hover:bg-raised border-line relative cursor-pointer rounded-[12px] border py-2 pr-3 pl-4 text-left",
												dismissed && "opacity-60",
											)}
											data-finding={f.rule}
										>
											<span
												aria-hidden
												className="absolute top-2 bottom-2 left-1.5 w-[3px] rounded-full"
												style={{
													background: dismissed
														? "var(--rc-fog)"
														: isFirstBlocking
															? "var(--rc-neon)"
															: f.severity === "must"
																? "var(--rc-stale)"
																: f.severity === "should"
																	? "var(--rc-bone)"
																	: "var(--rc-fog)",
												}}
											/>
											<div className="flex items-baseline justify-between gap-2">
												<span className="rc-mono text-[0.7rem] tracking-wide">
													<span className={f.severity === "must" && !dismissed ? "text-stale" : "text-fog"}>
														{dismissed ? "overridden" : f.severity}
													</span>
													<span className="text-fog">
														{" · "}
														{f.rule} · {formatTime(f.t)}
														{f.track ? ` · ${f.track}` : ""}
													</span>
												</span>
												{canOverride && (
													<button
														type="button"
														className="rc-mono text-fog hover:text-bone shrink-0 text-[0.7rem] underline-offset-2 hover:underline"
														onClick={(e) => {
															e.stopPropagation();
															setOverrideFor(f.id);
															setReason("");
															setFormError(null);
														}}
													>
														override
													</button>
												)}
												{f.rule === "CLAIM" && <span className="rc-mono text-fog text-[0.7rem]">no override (veto)</span>}
											</div>
											<p className="text-bone mt-0.5 text-sm leading-snug">{f.message}</p>
											<p className="text-fog text-xs leading-snug">→ {f.fix}</p>
											{dismissed && f.dismissed_reason && (
												<p className="rc-mono text-fog mt-1 text-[0.7rem]">
													override: “{f.dismissed_reason}”
												</p>
											)}
											{overrideForm(f.id, { finding: f })}
										</div>
									</li>
								);
							})}
						</ol>

						{report.not_run.length > 0 && (
							<>
								<div className="rc-label text-fog mt-5 mb-2">Did not run · the gate waits for these</div>
								<ul className="flex flex-col gap-1.5">
									{report.not_run.map((n) => (
										<li key={`${n.rule}-${n.why}`} className="bg-surface border-line rounded-[12px] border px-3 py-2">
											<div className="flex items-baseline justify-between gap-2">
												<span className="rc-mono text-stale text-[0.7rem]">{n.rule}</span>
												<button
													type="button"
													className="rc-mono text-fog hover:text-bone text-[0.7rem]"
													onClick={() => {
														setOverrideFor(`not-run-${n.rule}`);
														setReason("");
														setFormError(null);
													}}
												>
													waive (owner)
												</button>
											</div>
											<p className="text-fog text-xs">{n.why}</p>
											{overrideForm(`not-run-${n.rule}`, { rule: n.rule })}
										</li>
									))}
								</ul>
							</>
						)}

						{report.skipped.length > 0 && (
							<p className="rc-mono text-fog mt-4 text-[0.7rem]">
								Not applicable: {report.skipped.map((k) => `${k.rule} (${k.why})`).join(" · ")}
							</p>
						)}
					</>
				)}

				{overrides.length > 0 && (
					<>
						<div className="rc-label text-fog mt-5 mb-2">Owner overrides · D13</div>
						<ul className="flex flex-col gap-1.5">
							{overrides.map((o: GateOverride) => (
								<li key={o.at} className="border-line rounded-[12px] border px-3 py-2">
									<div className="flex items-baseline justify-between gap-2">
										<span className="rc-mono text-bone text-[0.7rem]">
											{o.rule}
											{o.t !== null && o.t !== undefined ? ` · ${formatTime(o.t)}` : ""} · {o.by_label ?? o.by} ·{" "}
											{new Date(o.at).toLocaleString()}
										</span>
										<button
											type="button"
											className="rc-mono text-fog hover:text-bone text-[0.7rem]"
											onClick={() => removeOverride(editor, o.at)}
										>
											withdraw
										</button>
									</div>
									<p className="text-fog text-xs">“{o.reason}”</p>
								</li>
							))}
						</ul>
					</>
				)}
			</div>

			<footer className="border-line flex flex-col gap-2 border-t px-5 py-3">
				<button
					type="button"
					disabled={!canDownload}
					onClick={() => {
						if (!s.fileName) return;
						if (onServer) {
							if (s.server) downloadServerRender(s.server, s.fileName);
							return;
						}
						if (!s.buffer) return;
						downloadBuffer({
							buffer: s.buffer,
							filename: s.fileName,
							mimeType: getExportMimeType({ format: s.format }),
						});
					}}
					className={cn(
						"h-11 w-full rounded-[12px] text-sm font-bold transition-colors",
						canDownload
							? "bg-neon text-ground shadow-[0_0_24px_rgba(246,255,0,0.35)] hover:brightness-95"
							: "bg-raised text-fog cursor-not-allowed",
					)}
					data-testid="gate-download"
				>
					{busy
						? `${word}…`
						: canDownload
							? "Download final"
							: report?.state === "BLOCKED"
								? `${blockingCount} fix${blockingCount === 1 ? "" : "es"} before export`
								: report?.state === "INCOMPLETE"
									? "Waiting for the missing checks"
									: "Download final"}
				</button>
				<div className="flex gap-2">
					{busy && onServer && s.phase !== "fixing" ? (
						<button
							type="button"
							className="rc-pill h-9 flex-1 text-xs"
							onClick={() => stopWaitingForServerRender()}
							title="The server finishes the render anyway; Render final on the same commit reuses it."
						>
							Stop waiting
						</button>
					) : busy && s.phase === "rendering" ? (
						<button type="button" className="rc-pill h-9 flex-1 text-xs" onClick={() => editor.project.cancelExport()}>
							Cancel render
						</button>
					) : (
						<button type="button" className="rc-pill h-9 flex-1 text-xs" onClick={rerun} disabled={busy}>
							Render and check again
						</button>
					)}
				</div>
				<p className="rc-mono text-fog text-[0.65rem] leading-snug">
					A MUST blocks the file. Only the project owner can override one, with a written reason (D13); claims
					never; Claude never. Overrides are stored on the project.
				</p>
			</footer>
		</aside>
	);
}
