// Default panel split, measured from docs/restorff/design/edit-artboard.png at 1440 px:
// left column ~237 px, inspector ~313 px, timeline ~a third of the height.
export const PANEL_CONFIG = {
	panels: {
		tools: 18,
		preview: 60,
		properties: 22,
		mainContent: 66,
		timeline: 34,
	},
} as const;
