import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SoundDesignReport } from "./apply";

interface SoundDesignStore {
	/** Options the button runs with (kept per browser). */
	captionTicks: boolean;
	duck: boolean;
	setCaptionTicks: (value: boolean) => void;
	setDuck: (value: boolean) => void;
	/** Last report per project (this session only). */
	reportByProject: Record<string, SoundDesignReport>;
	setReport: (args: { projectId: string; report: SoundDesignReport }) => void;
}

export const useSoundDesignStore = create<SoundDesignStore>()(
	persist(
		(set) => ({
			captionTicks: false,
			duck: true,
			setCaptionTicks: (value) => set({ captionTicks: value }),
			setDuck: (value) => set({ duck: value }),
			reportByProject: {},
			setReport: ({ projectId, report }) =>
				set((state) => ({ reportByProject: { ...state.reportByProject, [projectId]: report } })),
		}),
		{
			name: "restorffcut-sound-design",
			partialize: (state) => ({ captionTicks: state.captionTicks, duck: state.duck }),
		},
	),
);
