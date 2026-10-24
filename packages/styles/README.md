# @restorffcut/styles — saved styles and explainers from references (v0.1.0)

**What it does.** Two RestorffCut requirements, as pure TypeScript over `@restorffcut/timeline-ops` (every output is
ops@1, so the editor, the gateway and Claude over MCP can all use it):

- **EDT-20 · saved styles from repeated instructions.** From the history of sentences typed into "Tell Claude…" and
  the op batches they produced, `detectRepeats` finds an instruction (normalised wording) or an op pattern (batch
  shape, ids and times ignored) said ≥ 3 times and drafts a **saved style**: a PRE-01 `edit-style` preset with trigger
  sentences, an ops template and params. `saveStyle` versions it (1.0.0 → 1.1.0, old versions kept); `applyStyle`
  turns it into ops for any project.
- **EDT-21 · explainer from reference folders.** `styleCardFromReferences` measures a **style card** from frames the
  browser extracted (k-means palette with roles, mood, grain, pacing from scene changes, motion; lettering left as a
  question) with three questions (footage, format, feel). `explainerPlan` builds a **Paper collage** explainer as ops:
  footage cut at the references' pace, cut-out stills, label tags, and the collage compositions (paper-cut, map-route,
  retro-tv, thread-timeline, stamp, doodle-boil) coloured from the card; `report.missing` names what cannot be built yet.

**When to use it.** The editor's Styles tab and the inspector (`apps/web/src/styles-lab/`) call it; the MCP `styles`
tool can register saved styles with `styleExpanders(library)`. Not for built-in editing styles (those are
`timeline-ops/src/styles.ts`).

## Paths (relative to `restorffcut/packages/styles/`)
| Path | What |
|---|---|
| `src/preset.ts` | the saved-style shape (own copy of PRE-01, see below), validation, versions, library, JSON export/import |
| `src/repeats.ts` | `instructionKey`, `opShape`, `detectRepeats`, `draftStyle`, `planStyle` / `applyStyle`, `matchTrigger`, `styleExpanders` |
| `src/palette.ts` | k-means++ palette (seeded), HSL, luma, grain, histograms |
| `src/card.ts` | `styleCardFromReferences`, `sceneChangesFromFrames` |
| `src/explainer.ts` | `explainerPlan`, `bindCompositions`, `describePlan`, `collageColors`, `colorName` |
| `test/` | `bun test` (fictional Halcyon Cold Brew fixtures, synthetic pixels) |

The preset shape is a COPY of Restorff core's (`restorff/services/core/src/presets.mjs`, private repo): this package
ships in a public MIT repo and must not import from it. If core's `validatePreset` changes, update
`validateStylePreset` here.

## Setup
None beyond the repo's `bun install`. The web app depends on it as `"@restorffcut/styles": "workspace:*"`.

## Commands (run 2026-10-20)
```
cd C:\data\code\overkill\restorff-apps\restorffcut\packages\styles
bun test
node ../../node_modules/typescript/bin/tsc -p tsconfig.json
```
Expected: `13 pass, 0 fail` (~0.3 s); tsc prints nothing.

## Inputs and outputs (real examples from the tests)
EDT-20 — three records `"bigger captions"`, `"Bigger captions please"`, `"make the captions bigger"` (each with a
`set_caption_style {style:{size}}`) → one suggestion `pattern.key = "instruction:big caption"`, `count 3`, and a draft:
```
{ id: "bigger-captions", kind: "edit-style", stage: "edit", version: "1.0.0", triggers: ["bigger captions", …],
  steps: [{ kind: "op", op: { op: "set_caption_style", style: { size: { $param: "caption_size" } } }, each: "$captions" }],
  params: { caption_size: { type: "number", default: 7 } } }
```
`applyStyle(draft, project)` → `[{ op: "set_caption_style", style: { size: 7 }, author: "preset", track: "trk-captions" }]`.
Instructions tied to one project's clips ("tighter cut": split/delete/move) are saved as a **sentence step** and
re-resolved with `resolveSentence` on each project (same op types, new ids).

EDT-21 — `explainerPlan(card, { footage: "mine", feel: "nostalgic", dates: [...] }, assets, { start: 12 })` →
compositions `paper-cut, map-route, retro-tv, thread-timeline, stamp`, ops that pass `validateOps` and apply with 0
conflicts once `bindCompositions` swaps the `composition:<key>` placeholders for real media ids.

## Template steps (how a saved style re-applies)
| Step | Applied as |
|---|---|
| `{kind:"op", op, each:"$captions"}` | once per caption track that has captions (`track` = its id) |
| `{kind:"op", op, each:"$main"}` / `"$clips"` | on the main track / once per main-track clip |
| `{kind:"op", op}` | as is (grade, apply_style, normalize, set_canvas) |
| `{kind:"sentence", sentence}` | all sentence steps joined and resolved once with timeline-ops `resolveSentence`; anything it does not understand comes back in `unresolved` (hand it to the person's Claude) |
Values `{ "$param": name }` come from `style.params[name].default` or the caller's `params`.

## Known limits
- Op patterns compare op SHAPES: two `set_caption_style` with different sizes are one pattern (sizes are params).
- Grade ops are recorded, not drawn (the editor has no colour effect); notes say so.
- The style card cannot guess lettering, transitions or 2.5D depth from pixels: those need TVF / Claude.
- `explainerPlan` appends at `options.start`; the main track is magnetic to 0, so pass the end of the main track.
