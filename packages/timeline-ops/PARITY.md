# PARITY — editor commands ↔ ops@1 ↔ reducer ↔ tests

The editor's command classes (`apps/web/src/commands/**`, READ 2026-10-20) are the spec of each edit's effect. Claude
never calls them (BUILD-BRIEF B7); the reducer re-implements their effect on the project JSON. This table maps every
command class to the op(s) that reproduce it, the reducer function, and the test that pins it.

**Count:** `grep -rn "^export class" apps/web/src/commands` → 41 lines = **40 command classes** + `PreviewTracker`
(a snapshot helper, not a command). Test names are "describe › test" from `test/*.test.ts`.

**Parity status:** every row below is parity **by reading the source**. No test yet runs the browser command and the
reducer on the same input and diffs the JSON (that needs the editor's singleton in a headless browser; see
README "Next"). Tests pin the reducer's behaviour, including the editor rules it copies.

## Media, project, scenes

| Command | Op(s) | Reducer | Test | Notes |
|---|---|---|---|---|
| `AddMediaAssetCommand` | `import_media` | `opImportMedia` | media › import_media adds a manifest entry; a ref resolves it; a repeat import is a no-op | Partial: the asset itself lives in the media store, outside the project; the reducer records a manifest entry in `metadata.restorff.media` with a deterministic id the gateway must reuse. The command's fps ratchet is not copied (D4). |
| `RemoveMediaAssetCommand` | — | — | — | Not covered: no media-removal op in plan/06 §5. Claude deletes elements; asset clean-up is the gateway's job. |
| `UpdateProjectSettingsCommand` | `set_canvas` | `opSetCanvas` | canvas › set_canvas sets size, fps (float → exact rational) and background; canvas › set_canvas refuses a frame rate with a non-integer tick count per frame | Only `canvasSize`, `fps`, `background`. Timestamp only with `at` (D9). |
| `CreateSceneCommand` | — | — | — | Not covered: ops@1 edits one scene (`ApplyOptions.sceneId`, default the current scene); no scene op in §5. |
| `DeleteSceneCommand` | — | — | — | Not covered (same reason). |
| `RenameSceneCommand` | — | — | — | Not covered (same reason). |
| `ToggleBookmarkCommand` | `mark` | `opMark` | look and notes › mark adds a frame-rounded bookmark, and updates the one already on that frame | `mark` adds or updates; it never removes (D11). Same frame rounding (`bookmarks/utils.ts:109`). |
| `UpdateBookmarkCommand` | `mark` (same frame) | `opMark` | (same test) | note / color / duration. |
| `MoveBookmarkCommand` | — | — | — | Not covered: no op. Proposed for ops@2 with `unmark`. |
| `RemoveBookmarkCommand` | — | — | — | Not covered: no `unmark` op in §5. |

## Elements

| Command | Op(s) | Reducer | Test | Notes |
|---|---|---|---|---|
| `InsertElementCommand` | `insert`; also used by `add_captions`, `text_pop`, `sfx` | `opInsert`, `buildInsertElement`, `opAddCaptions`, `opTextPop`, `opSfx` | elements › insert media: in/out become exact tick trims within the media; › insert text, image and shape with editor defaults plus style; › insert refuses overlaps, wrong track types and trims past the media; › insert on an empty main track snaps to 0 (the editor's magnetic main track) | Same element builders and defaults (`element-utils.ts`, `defaults.ts`), same main-track rule. Differences: ops always name a track (no "auto" placement); overlaps refused (D5); no auto canvas/fps from the first visual media (D4). |
| `DeleteElementsCommand` | `delete` | `opDelete` | elements › delete and ripple_delete (track scope and all tracks) | One element per op. |
| `DuplicateElementsCommand` | — | — | — | Not covered: no op; Claude inserts again. (The command puts copies on a new top track.) |
| `SplitElementsCommand` | `split` | `opSplit` + `splitAnimationsAtTime` | elements › split: left keeps the id, right is new; trims and names follow SplitElementsCommand; split / delete / trim algebra › (all five) | Same "snap the source split once" maths, same " (left)"/" (right)" names, same keyframe split. `retainSide` left/right = split + delete. D2, D3, D8. |
| `UpdateElementsCommand` | `set`, `gain`, `set_caption_style` (and `trim`'s clamp) | `opSet`, `setSpeed`, `opGain`, `opSetCaptionStyle`, `applyParams` | motion › set maps friendly props onto editor params and coerces like the editor; › set refuses unknown props and impossible track props; › set speed retimes: duration follows the visible source span; audio › gain sets the element level in dB; text › set_caption_style restyles every caption… | Params coerced with the editor's `coerceParamValue`; the update pipeline's retime rule (`update-pipeline.ts:35-80`) and duration→keyframe clamp are ported. |
| `MoveElementCommand` | `move` | `opMove` | elements › move along a track and onto another track of the same type | Same track-type check and "filter out, append to target". Main-track start rule applied (from the drag planner / update pipeline). Overlap refused (D5). |
| `ToggleSourceAudioSeparationCommand` | `set {prop: "source_audio", value}` | `setSourceAudio` | motion › set source_audio false extracts the audio (audio separation); true recovers it | Absolute value instead of toggle (D11). Same extracted element (`buildSeparatedAudioElement`), same placement (first free audio track, else a new one at the top of the audio group). |

## Effects and masks

| Command | Op(s) | Reducer | Test | Notes |
|---|---|---|---|---|
| `AddClipEffectCommand` | `grade` (clip / track target) | an effect `{type: "restorff-grade"}` appended to `effects` (or the existing grade updated in place) | `grades.test.ts` | Only the grade effect has an op; other effects (blur, zoom…) still have none. `grade {target: "all"}` = `InsertElementCommand` of an effect element on a new GRADE effect track (grade agent, 2026-10-20). |
| `RemoveClipEffectCommand` | — | — | — | Not covered (same). |
| `ReorderClipEffectsCommand` | — | — | — | Not covered (same). |
| `ToggleClipEffectCommand` | — | — | — | Not covered (same). |
| `UpdateClipEffectParamsCommand` | — | — | — | Not covered (same). |
| `RemoveMaskCommand` | — | — | — | Not covered: no mask op in §5; masks pass through untouched. |
| `ToggleMaskInvertedCommand` | — | — | — | Not covered (same). |
| `InsertFreeformPathMaskPointCommand` | — | — | — | Not covered (same). |
| `DeleteFreeformPathMaskPointsCommand` | — | — | — | Not covered (same). |

## Keyframes

| Command | Op(s) | Reducer | Test | Notes |
|---|---|---|---|---|
| `UpsertKeyframeCommand` | `keyframe`; also `text_pop`, `transition` (dip), `duck` | `opKeyframe`, `upsertScalarKeyframe` | motion › keyframe: timeline time → element-relative ticks; ease shapes the segment into the key; › keyframe: scale writes both axes; times clamp to the element; a key at the same tick is replaced; › keyframe: crop is kept pending; a non-keyframable param is refused | Same upsert (same-tick key replaced, keeps its id), same clamp to `[0, duration]`. Numbers only (no colour keyframes). D6. |
| `UpdateScalarKeyframeCurveCommand` | `keyframe` with `ease` | `applyEase` | (keyframe ease test above) | Partial: writes handles for ease_in / ease_out / ease_in_out; no free-form handles. |
| `RemoveKeyframeCommand` | — | — | — | Not covered: no op in §5 (proposed `unkeyframe`). |
| `RetimeKeyframeCommand` | — | — | — | Not covered: no op; a new `keyframe` at the new time is the workaround (leaves the old key). |
| `UpsertEffectParamKeyframeCommand` | — | — | — | Not covered: no effect op. |
| `RemoveEffectParamKeyframeCommand` | — | — | — | Not covered: no effect op. |
| `PasteKeyframesCommand` | — | — | — | Not covered: Claude has no clipboard; it emits `keyframe` ops. |

## Tracks, clipboard, infrastructure

| Command | Op(s) | Reducer | Test | Notes |
|---|---|---|---|---|
| `AddTrackCommand` | `add_track` (and implicitly `add_captions`, `text_pop`, `sfx`, `source_audio`) | `opAddTrack`, `createTrack` | tracks › add_track: caption on top, video just above main, audio at the bottom, overlay = graphic; › unnamed tracks get the editor's artboard names (timeline/tracks.ts getDefaultTrackName) | Same default positions (`insert-index.ts`) and names (`getDefaultTrackName`, renamed by the skin agent 2026-10-20). `caption` = a text track named CAPTIONS at index 0, like subtitle import. `overlay` = a graphic track. |
| `RemoveTrackCommand` | `remove_track` | `opRemoveTrack` | tracks › remove_track removes the track and its elements; the main track cannot go | The command silently ignores the main track; the reducer reports a conflict. |
| `ToggleTrackMuteCommand` | `set {track, prop: "muted"}` | `opSet` | motion › set maps friendly props onto editor params and coerces like the editor | Absolute value (D11). |
| `ToggleTrackVisibilityCommand` | `set {track, prop: "hidden"}` | `opSet` | motion › set refuses unknown props and impossible track props | Absolute value (D11); audio tracks refused like `canTrackBeHidden`. |
| `PasteCommand` | — | — | — | Not covered: no clipboard; equivalent is `insert`. |
| `BatchCommand` | the batch passed to `apply` | `apply` (`mode: "atomic"`) | batch modes › atomic (default): a conflict leaves the project untouched and reports where; › best_effort… | Atomic by default, unlike BatchCommand (which has no failure path). |
| `TracksSnapshotCommand` | `trim` (resize), `move` (drag) | `opTrim`, `opMove` | elements › trim keeps the kept frames where they were (content-anchored, like the editor's resize); › trim refuses going past the media, under one frame, or before timeline 0 | The UI commits drags and resizes as snapshots of `computeGroupResize` / the move planner; `trim` reproduces the resize maths (one-frame minimum, source bounds). D7. |

## Ops with no single command behind them

| Op | What it does | Test |
|---|---|---|
| `reorder_tracks` | permutes overlay and audio groups; refuses audio above main | tracks › reorder_tracks reorders within the groups and refuses audio above main |
| `ripple_delete` | delete + the editor's ripple shift (`ripple/shift.ts`) on the track, or all tracks | elements › delete and ripple_delete (track scope and all tracks); split / delete / trim algebra › ripple_delete shortens the track… |
| `duck` | writes a linear volume envelope (dB) on the music under the voice spans (or under explicit `spans`, v32) | audio › duck writes a volume envelope on the music under each voice span; › duck with explicit voice spans ducks only there |
| `transition` | `cut`/`match` no-op; `fade` = opacity keyframes; every kind in `src/transitions.ts` (24 + aliases) = `transitionIn` on the incoming clip (v32, rendered by the wasm compositor); unknown kinds pending | transitions › (four tests) |
| `beats` | stores a source-time beat grid on a music element (v32 `beats`) | audio › beats store source-time beats…; snap_cuts rolls a cut… |
| `snap_cuts` | rolls each cut on a track onto the nearest beat (frame-rounded, ≤ max_shift, needs trim handles) — the editor's "Snap cuts to beats" | (same test) |
| `normalize` | sets `settings.loudness` (v32); the export masters to it, measured on the encoded file | audio › normalize sets the master loudness target… |
| `text_pop` | text element + scale/opacity pop keyframes | text › text_pop: a text element that pops (scale + opacity keyframes) |
| `add_captions` | 1-3-word text elements on a caption track | text › add_captions makes a caption track on top with 1-3-word chunks |
| `apply_style` | expands a preset to ops, recorded expanded (author "preset") | text › set_caption_style restyles every caption; apply_style is recorded expanded |
| `add_size_variant`, `grade` with an unknown look or a LUT, `sfx` by name, `transition` of an unknown kind, `keyframe` crop | stored as pending instructions + `changes.unsupported` | canvas › add_size_variant…; look and notes › grade…; audio › sfx…; transitions › dip, whip, dissolve…; motion › keyframe: crop… |

## Divergences (deliberate) and editor bugs found

| # | What | Why |
|---|---|---|
| D1 | Ids are UUID-shaped hashes of `(seed, op index, counter)`, not `crypto.randomUUID` | Determinism: same input, same output. |
| D2 | **Editor bug (READ, not run):** splitting inside a bezier segment duplicates the left key — `animation/keyframes.ts:1094` keeps every key with `time < splitTime` (which includes the segment's left key) and then appends a modified copy of that same key. The reducer emits it once. | A channel with two keys of the same id and time is not what anyone wants; worth fixing upstream (owner of `apps/web`). |
| D3 | **Editor bug (READ in the editor; MEASURED on the faithful port, whose continuity test failed with NaN until the fix):** a split after a channel's last key leaves the right half with no keys (and before the first key, the left half), so that half shows the static param value — the picture jumps at the cut. The reducer adds a hold key. | Content correctness. Test: split / delete / trim algebra › split keeps every animated value continuous at the cut. |
| D4 | No automatic canvas size / fps from the first visual media (`insert-element.ts` first-element block; `AddMediaAssetCommand` fps ratchet) | Ops are explicit; the compiler emits `set_canvas` first. |
| D5 | Overlaps on one track are refused, even on an explicit track (the command doesn't check) | Invariant; avoids silent layering. |
| D6 | `ease` shapes the segment arriving at the key (sets the previous key's `segmentToNext` and handles); the command's `interpolation` sets the key's own outgoing segment | "Reach 1.15 by 9 s, eased" reads naturally and needs no hidden state. |
| D7 | `trim` also clamps keyframes to the new duration (the update pipeline's rule); the UI's resize snapshot leaves out-of-range keys. A left trim does not shift keyframes, same as the editor. | Keeps invariant 7. Callers should trim before keyframing. |
| D8 | Split outside an element, removing the main track, an unknown target: conflicts, where the commands silently do nothing | Claude must hear about it. |
| D9 | No clock: timestamps change only when `at` is passed | Purity. |
| D10 | `metadata.duration` is recomputed from the main scene after a batch | Keeps the stored duration true. |
| D11 | Toggles become absolute sets (mute, hidden, source audio, bookmarks) | Idempotent ops replay safely. |
| D12 | Adds `restorff` tags on metadata, tracks and elements (MODEL §8) | Pending instructions, media manifest, author per element. |
