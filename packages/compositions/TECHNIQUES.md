# Techniques — when to use what (schema v1)

Every effect, transition, caption style, grade, sound move and edit move the **director** can choose has one
**technique record**: what job it does for the viewer, which beats it fits, how loud it is, how long it runs, where it
sits, what it needs, what it pairs with and how often it may repeat. The director's planner
(`apps/web/src/server/director*.ts`, MCP tool `director`) reads these at run time and picks per beat.

- Types + validator: [`src/technique.ts`](src/technique.ts) (`TechniqueMeta`, `validateTechnique`, `validateCatalogue`).
- Built-in records: `src/techniques-*.ts` (the 62 FX rows, package compositions, transitions, grades, caption styles,
  sound moves, edit moves, style presets). Loader: `src/technique-registry.ts` (`loadTechniques()`).
- Long-form playbooks (how to do each well, adapted from HyperFrames' skills): `knowledge/` (hf-skills agent). Link
  them from a record's `knowledge` field; do not copy prose into records.

## For imports (fx-sync): one sidecar per composition

Write `compositions/<name>/<name>.technique.json` next to `<name>.html`. It never changes the render hash (the HTML is
untouched). `id` may be left out (it becomes `comp:<name>`); `apply` may be left out (it becomes `effects` → `comp:<name>`).

```json
{
  "kind": "effect",
  "name": "Stat Slam",
  "purpose": ["number-data", "emphasis"],
  "beats": ["number", "proof"],
  "energy": 4,
  "duration": { "min": 1.2, "max": 3, "ideal": 2 },
  "aspects": ["9:16", "4:5", "1:1"],
  "placement": "face-safe",
  "needs": ["numbers"],
  "pairsWith": ["sfx:hit", "purpose:emphasis"],
  "avoidWith": ["FX-32"],
  "minSpacing": 10,
  "withCaptions": "move",
  "cost": { "renderS": 25, "basis": "estimate" },
  "retention": "A number that moves is read; a number that sits is skipped.",
  "example": "Halcyon sold 40,000 cans in the first month.",
  "fill": { "value": "number", "label": "number-label" },
  "credit": "Adapted from HyperFrames blocks/stat-slam (Apache-2.0) @fa5dbd1; modified",
  "knowledge": ["knowledge/numbers.md"]
}
```

## Fields (all required unless marked optional)

| Field | Values | Meaning |
|---|---|---|
| `id` | `FX-NN`, `comp:<name>`, `tr:<kind>`, `grade:<look>`, `shader:<type>`, `move:<slug>`, `cap:<style>`, `sfx:<slug>`, `style:<preset>` | Library id where one exists |
| `kind` | effect · transition · caption-style · grade · sound · edit-move · style | |
| `purpose` | hook · emphasis · pattern-interrupt · transition · list-steps · number-data · proof-social · product-showcase · comparison · cta · b-roll-replace · explain-concept · mood | first = main job |
| `beats` | hook · problem · claim · number · list · steps · proof · product · comparison · explain · story · reveal · quote · cta · bridge | best first |
| `energy` | 1–5 | 1 calm (grade, soft fade) … 5 loud (stamp, flash, whip + hit) |
| `duration` | `{min, max, ideal?}` s | on screen |
| `aspects` | 9:16 · 4:5 · 1:1 · 16:9 (empty = all) | |
| `placement` | full-frame · overlay · lower-third · behind-person · face-safe · clip · cut · audio · caption-zone | full-frame = a cutaway (the face leaves) |
| `needs` | person_matte · face_box · words · images · product_image · numbers · list_items · places · two_clips · clip · clean_plate · cut_list · self_check · two_renders · quote · logo · music | a need the timeline can't supply excludes it |
| `pairsWith` / `avoidWith` | ids or selectors `kind:sound`, `purpose:emphasis`, `beat:cta` | |
| `minSpacing` | s | no reuse inside this window |
| `withCaptions` | keep · move · hide | hide = it IS the text for its span |
| `cost` | `{renderS, basis: measured\|estimate}` | wall seconds for one typical use |
| `retention` | one line | why it holds attention |
| `example` | a spoken sentence | what should trigger it |
| `apply` | `{via: effects, ref}` · `{via: captions, style}` · `{via: sounds, sound}` · `{via: ops, op}` · `{via: style, preset}` · `{via: manual, why}` | how the planner applies it |
| `fill` (opt.) | param → keyword · line · headline · number · number-text · number-label · numbers · list-items · product-name · product-image · brand · cta-text · cta-keyword · places · images · quote · before · after · words · beat-start | params filled from the words (`words` = the beat's word timings shaped to the param: `{w,s,e}` · `{text,start,end}` · `{text,at}`; timeline seconds when the composition has a `t0` param, else seconds from its start) |
| `fillOptional` (opt.) | fill keys | keys that may stay empty. **Every other fill key is required**: nothing behind it = the technique is not chosen (an applied composition shows "" / [] for an empty display param) |
| `look` (opt.) | neon · paper · glass · editorial · ui · clean · photo · retro | look family; a style keeps to its families so one piece keeps one look (ids the style names itself are allowed) |
| `params` (opt.) | fixed values | e.g. a transition's duration |
| `evidence`, `credit`, `knowledge`, `notes` (opt.) | strings | reels / FINDINGS lines; licence credit; playbook paths; gotchas |

Check a sidecar: `bun -e "import {validateTechnique} from './src/technique.ts'; console.log(validateTechnique(JSON.parse(await Bun.file(process.argv[1]).text())))" compositions/<name>/<name>.technique.json`
(from `packages/compositions`), or run `bun test` there — `test/technique.test.ts` validates every built-in and every sidecar.

## Rules for writing a record (each learned on the live run, 2026-10-24)

- Fill only what the words can supply; a fill key the line can't fill makes the technique unchoosable for that beat —
  that is the point (one-bar charts and empty titles are worse than another technique). Mark true extras `fillOptional`.
- A single word longer than a param's `maxLength` is left out, never sliced ("nothing" must not become "not").
- `minSpacing` is symmetric (no other use within that many seconds either side).
- Give `look` to anything with a strong visual identity (neon grids, paper, glass, magazine type); leave it off neutral
  pieces (counters, stamps, strikes) so every style can use them.

## The grammar the defaults come from (MEASURED, `spikes/s6-reference-reels/FINDINGS.md`)

Speech fills 89–99 % of a reel · captions change every 1–5 words · at least one big-word punch per reel · overlays
never cover the face · every reel ends on a CTA · 2–10 visual beats per 10 s by style. The director's rules (hook
inside 1 s, an interrupt every 1.5–3 s or the style's rate, no reuse inside `minSpacing`, energy rising to the payoff,
CTA last, face-safe, captions not fought) are in `apps/web/src/server/director-rules.ts`.
