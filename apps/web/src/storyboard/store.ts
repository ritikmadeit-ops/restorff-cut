/**
 * Which centre view the editor shows: the live Edit preview, or the
 * storyboard (one card per shot, reel DeUUFJQu8cw: "before rendering, it gives
 * me a complete storyboard"). `compare` turns on the before/after wipe over the
 * preview (reel: the "make it more aesthetic" wipe). UI state only, not saved.
 */
import { create } from "zustand";

export type CentreView = "edit" | "storyboard";

interface StoryboardState {
	view: CentreView;
	compare: boolean;
	setView: (view: CentreView) => void;
	toggleView: () => void;
	setCompare: (on: boolean) => void;
	toggleCompare: () => void;
}

export const useStoryboardStore = create<StoryboardState>()((set) => ({
	view: "edit",
	compare: false,
	setView: (view) => set({ view, ...(view === "storyboard" && { compare: false }) }),
	toggleView: () =>
		set((s) => ({
			view: s.view === "edit" ? "storyboard" : "edit",
			compare: false,
		})),
	setCompare: (on) => set({ compare: on, ...(on && { view: "edit" as const }) }),
	toggleCompare: () =>
		set((s) => ({ compare: !s.compare, ...(!s.compare && { view: "edit" as const }) })),
}));
