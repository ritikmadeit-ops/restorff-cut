import { PlaybackManager } from "./managers/playback-manager";
import { TimelineManager } from "./managers/timeline-manager";
import { ScenesManager } from "./managers/scenes-manager";
import { ProjectManager } from "./managers/project-manager";
import { MediaManager } from "./managers/media-manager";
import { RendererManager } from "./managers/renderer-manager";
import { CommandManager } from "./managers/commands";
import { SaveManager } from "./managers/save-manager";
import { AudioManager } from "./managers/audio-manager";
import { SelectionManager } from "./managers/selection-manager";
import { ClipboardManager } from "./managers/clipboard-manager";
import { DiagnosticsManager } from "./managers/diagnostics-manager";
import { registerDefaultEffects } from "@/effects";
import { registerDefaultMasks } from "@/masks";
import { registerTranscriptionDiagnostics } from "@/transcription/diagnostics";
import { createRestorffLaneKeeper } from "@/timeline/restorff-lanes";

export class EditorCore {
	private static instance: EditorCore | null = null;
	public readonly timeline: TimelineManager;
	public readonly command: CommandManager;
	public readonly playback: PlaybackManager;
	public readonly scenes: ScenesManager;
	public readonly project: ProjectManager;
	public readonly media: MediaManager;
	public readonly renderer: RendererManager;
	public readonly save: SaveManager;
	public readonly audio: AudioManager;
	public readonly selection: SelectionManager;
	public readonly clipboard: ClipboardManager;
	public readonly diagnostics: DiagnosticsManager;

	private constructor() {
		registerDefaultEffects();
		registerDefaultMasks();
		this.command = new CommandManager(this);
		this.timeline = new TimelineManager(this);
		this.playback = new PlaybackManager(this);
		this.scenes = new ScenesManager(this);
		this.project = new ProjectManager(this);
		this.media = new MediaManager(this);
		this.renderer = new RendererManager(this);
		this.save = new SaveManager({ editor: this });
		this.audio = new AudioManager(this);
		this.selection = new SelectionManager(this);
		this.clipboard = new ClipboardManager(this);
		this.diagnostics = new DiagnosticsManager(this);
		registerTranscriptionDiagnostics({ diagnostics: this.diagnostics });
		this.playback.bindTimelineScope();
		this.command.registerReactor(() => {
			const activeScene = this.scenes.getActiveSceneOrNull();
			if (!activeScene) {
				return;
			}

			const tracks = activeScene.tracks;
			// RestorffCut (polish, 2026-10-20): the artboard's lanes (TEXT · CAPTIONS · V2 B-ROLL · MUSIC · SFX; V1 A-ROLL
			// is the main track) are FIXED — the gateway skeleton creates them empty and ops fill them. Upstream dropped
			// every empty overlay/audio track after each command, so they vanished on the first edit. Keep the first
			// empty track per Restorff lane; other empty tracks (V3, AUDIO 3, GRAPHICS, duplicates) are still pruned.
			const keepEmptyLane = createRestorffLaneKeeper();
			const prunedTracks = {
				...tracks,
				overlay: tracks.overlay.filter(
					(track) => track.elements.length > 0 || keepEmptyLane(track, tracks),
				),
				audio: tracks.audio.filter(
					(track) => track.elements.length > 0 || keepEmptyLane(track, tracks),
				),
			};
			if (
				prunedTracks.overlay.length !== tracks.overlay.length ||
				prunedTracks.audio.length !== tracks.audio.length
			) {
				this.timeline.updateTracks(prunedTracks);
			}
		});
		this.save.start();
	}

	static getInstance(): EditorCore {
		if (!EditorCore.instance) {
			EditorCore.instance = new EditorCore();
		}
		return EditorCore.instance;
	}

	static reset(): void {
		EditorCore.instance = null;
	}
}
