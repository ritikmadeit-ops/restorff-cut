# Changelog — @restorffcut/styles

## 0.1.0 - 2026-10-20
- First version (styles agent). EDT-20: `detectRepeats` (normalised wording + op shapes, threshold 3, by records or
  projects, skips saved/dismissed patterns), `draftStyle` (op steps with params lifted, sentence steps for clip-bound
  instructions), `saveStyle` / `restoreVersion` (versions kept), `applyStyle` / `planStyle`, `matchTrigger`,
  `styleExpanders`, JSON export/import. EDT-21: `styleCardFromReferences` (k-means palette with roles, mood, grain,
  pacing, motion, three questions), `explainerPlan` on the Paper collage preset, `bindCompositions`, `describePlan`.
  13 bun tests.

## Next (ideas, not started)
- Saved styles on the server (per org), so the MCP `styles` tool lists and applies them (today: browser only).
- Record Claude's MCP `timeline_ops` commits in the history too (today only the command bar records).
- Learn param ranges from all examples (e.g. caption size min/max) instead of the latest value only.
- Style card from TVF: shot list, transcript, lettering (OCR), transitions; a "feel" read by Claude from the card.
- Explainer: a paper texture background composition (FX-53), cut-out outline shader (FX-52), parallax strip (FX-61),
  triptych (FX-57); a script from Claude instead of placeholder lines; music and SFX via the sound designer.
