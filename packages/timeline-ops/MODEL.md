# MODEL — RestorffCut's project JSON, as it really is

READ from the source at commit `238750c0` plus the working tree on 2026-10-20 (paths are under `apps/web/src/` unless
they start with `rust/`). The TypeScript mirror is [src/model.ts](src/model.ts). Every "file:line" was re-read the
day it was written — but the skin agent edits `apps/web` at the same time (it renamed tracks mid-session), so
re-check a line number before trusting it.

## 1. Where the project lives

- In memory the editor holds a `TProject` (`project/types.ts:44`) with `Date` objects.
- On disk (IndexedDB) it stores a `SerializedProject` (`services/storage/types.ts:45`): the same shape with ISO-string
  dates. `StorageService.saveProject` (`services/storage/service.ts:134`) writes it **field by field**:
  `metadata` is rebuilt from six named fields (`service.ts:149-156`), each scene from seven, while `scene.tracks` is
  stored as-is apart from dropping audio `buffer`s (`service.ts:121-132`, `:142`).
- Schema version **31** (`services/storage/migrations/index.ts:36`); migrations v0→v31 run on load.
- **Media is not in the project.** Files live in a separate media store as `MediaAssetData`
  (`services/storage/types.ts:17`: id, name, type, size, width, height, duration, fps, hasAudio…). Elements point at
  them by `mediaId`.

The reducer works on the serialized form (what a commit stores). It never reads the dates, so `Date` objects pass
through too (`structuredClone` keeps them).

## 2. Time

| Thing | Value | Source |
|---|---|---|
| Unit | integer **ticks**, `MediaTime` | `wasm/media-time.ts:25` (a branded `number`), `rust/crates/time/src/media_time.rs:16` (`i64`) |
| Tick rate | **120 000 ticks per second** | `rust/crates/time/src/media_time.rs:10` |
| seconds → ticks | `round_half_away_from_zero(seconds × 120000)`; non-finite → none | `media_time.rs:30-37`; TS side `wasm/media-time.ts:80` |
| fractional → ticks | same rounding, `-0` normalised to `0` | `wasm/media-time.ts:69` |
| Frame rate | `{numerator, denominator}` | `rust/crates/time/src/frame_rate.rs:8` |
| Ticks per frame | `120000 × den / num`, must be an integer (30 fps = 4 000, 29.97 = 4 004, 23.976 = 5 005, 25 = 4 800, 60 = 2 000) | `frame_rate.rs:82-94`, tests `:101-113` |
| Frame rounding | `remainder × 2 ≥ tpf` rounds up | `media_time.rs:48-57` |
| float fps → rational | standard rates within 0.01, else integer, else `/1e6` reduced | `fps/utils.ts` `floatToFrameRate` |

Element times (`startTime`, `duration`, `trimStart`, `trimEnd`, `sourceDuration`) and keyframe times are all ticks.
**Keyframe times are relative to the element's start** (`animation/types.ts:65`). Bookmark times are absolute and
frame-rounded (`timeline/bookmarks/utils.ts:109`).

The reducer ports these rules to plain TypeScript (`src/time.ts`) so it needs no wasm; the property test
"ticks → seconds → ticks is the identity for 10 000 random tick counts" and Rust's own test cases pin it.

## 3. Project

`TProject` (`project/types.ts:44`):

| Field | Shape / unit | Notes |
|---|---|---|
| `metadata` | `{id, name, thumbnail?, duration: ticks, createdAt, updatedAt}` (`:20`) | `duration` = end of the last element in the main scene |
| `scenes` | `TScene[]` | exactly one has `isMain: true`; the main scene cannot be deleted |
| `currentSceneId` | string | the scene the editor shows; the reducer edits it by default |
| `settings` | `{fps, canvasSize: {width, height}, canvasSizeMode?, lastCustomCanvasSize?, originalCanvasSize?, background}` (`:29`) | background `{type:"color", color}` or `{type:"blur", blurIntensity}` (`:5`) |
| `version` | number | 31 |
| `timelineViewState?` | `{zoomLevel, scrollLeft, playheadTime}` (`:38`) | UI only |

## 4. Scenes and tracks

`TScene` (`timeline/types.ts:19`): `{id, name, isMain, tracks, bookmarks, createdAt, updatedAt}`.

`SceneTracks` (`timeline/types.ts:76`) is **three groups**, displayed top to bottom:

```text
overlay[]   video · text · graphic · effect tracks   (index 0 = top)
main        ONE video track, always present, cannot be removed
audio[]     audio tracks                              (index 0 = just below main)
```

| Track type | Fields | Holds |
|---|---|---|
| `video` | `id, name, elements, muted, hidden` (`:36`) | `video`, `image` elements |
| `text` | `id, name, elements, hidden` | `text` |
| `audio` | `id, name, elements, muted` (`:49`) | `audio` |
| `graphic` | `id, name, elements, hidden` | `sticker`, `graphic` |
| `effect` | `id, name, elements, hidden` | `effect` (adjustment-layer style) |

Element → track type map: `timeline/placement/compatibility.ts:3`.

**Track names** follow the Edit artboard (the skin agent changed them on 2026-10-20, while this file was being
written — upstream said "Video track", "Main Track"…): the main track is "V1 A-ROLL" (`timeline/placement/main-track.ts:4`);
a new track is named by `getDefaultTrackName` (`timeline/tracks.ts`) from the tracks that already exist: video
"V2 B-ROLL", then "V3", "V4"…; audio "MUSIC", then "SFX", then "AUDIO 3"…; text "TEXT", "TEXT 2"…; graphic "GRAPHICS";
effect "EFFECTS"; subtitle import names its track "CAPTIONS" (`CAPTIONS_TRACK_NAME`, `subtitles/insert.ts:25`). Both
`AddTrackCommand` and automatic placement (`timeline/placement/apply.ts`) use it.

Rules the editor applies (all READ):
- **New track position** (`timeline/placement/insert-index.ts:3`): audio → bottom of the audio group; effect → top;
  video/text/graphic → bottom of the overlay group (just above main). Subtitle import adds its text track at index 0
  (`subtitles/insert.ts:22-26`).
- **The main track is magnetic to 0**: an element placed at or before the earliest main-track element starts at 0
  (`timeline/placement/main-track.ts:27`, also `timeline/update-pipeline.ts:98-131` for `startTime` patches).
- **Elements are appended** to `track.elements` (not kept sorted) by insert and move (`placement/apply.ts:41`,
  `commands/timeline/element/move-elements.ts:107`).
- **Overlap**: automatic placement only uses a track where the span is free (`placement/overlap.ts`); an explicit
  insert does not check (`placement/resolve.ts:147-166`). The reducer treats any overlap on one track as a conflict.

## 5. Elements

Common fields (`BaseTimelineElement`, `timeline/types.ts:105`):

| Field | Unit | Meaning |
|---|---|---|
| `id`, `name` | string | `name` gets " (left)" / " (right)" on split |
| `startTime` | ticks | timeline position |
| `duration` | ticks | timeline length |
| `trimStart` / `trimEnd` | ticks of **source** | how much of the media is hidden before / after |
| `sourceDuration?` | ticks | media length (set for video/audio from media) |
| `animations?` | `ElementAnimations` | §6 |
| `params` | `Record<string, number \| string \| boolean>` | §5.1 |

For media elements: `trimStart + round(duration × rate) + trimEnd = sourceDuration`, where `rate` is
`retime.rate` (video/audio, clamped to 0.01-5, `retime/rate.ts`) or 1. Split and resize both preserve it by
"snapping once" (`commands/timeline/element/split-elements.ts:94-114`, `timeline/group-resize/compute-resize.ts:81-87`).
Resize never makes a clip shorter than one frame (`compute-resize.ts:36`).

Types (`timeline/types.ts`):
- `video` (`:117`): `mediaId`, `isSourceAudioEnabled?` (false = audio extracted to a separate element), `hidden?`,
  `retime?`, `effects?`, `masks?`.
- `image` (`:127`): `mediaId`, `hidden?`, `effects?`, `masks?`. No `sourceDuration`.
- `audio` (`:87-103`): `sourceType: "upload"` + `mediaId`, or `"library"` + `sourceUrl`; `retime?`; `buffer` is
  runtime-only and never stored.
- `text` (`:135`): everything is in `params`; `hidden?`, `effects?`.
- `sticker` (`:141`): `stickerId`, `intrinsicWidth/Height?`.
- `graphic` (`:151`): `definitionId` (`rectangle` · `ellipse` · `star` · `polygon`, `graphics/definitions/`).
- `effect` (`:159`): `effectType`; params are the effect's.

New-element defaults: 5 s duration (`timeline/creation.ts:3`), trims 0, video `isSourceAudioEnabled: true, hidden:
false` (`timeline/element-utils.ts:221-245`), text defaults in `timeline/defaults.ts:31-64`.

### 5.1 Params (`params/registry.ts:96-352`)

| Param | Element types | Unit / range | Keyframable |
|---|---|---|---|
| `transform.positionX` / `Y` | visual (video, image, text, sticker, graphic) | canvas px from the canvas **centre**, y down (`services/renderer/compositor/frame-descriptor.ts:348`) | yes |
| `transform.scaleX` / `Y` | visual | multiplier of the **contain**-fitted size (`frame-descriptor.ts:338`), min 0.01 | yes |
| `transform.rotate` | visual | degrees, −360..360 | yes |
| `opacity` | visual | 0..1 | yes |
| `blendMode` | visual | 17 CSS blend modes | no |
| `volume` | video, audio | **dB**, −60..+20 (`timeline/audio-constants.ts`) | yes |
| `muted` | video, audio | boolean | no |
| `content` | text | string, never blank | no |
| `fontFamily`, `textAlign`, `fontWeight` (normal/bold), `fontStyle`, `textDecoration` | text | strings | no |
| `fontSize` | text | editor units: px = size × canvasHeight / 90 (`text/typography.ts:9`) | yes |
| `color`, `background.color` | text | CSS colour; animated as a composite linear-RGBA channel | yes |
| `letterSpacing`, `lineHeight` | text | | yes |
| `background.enabled` / `cornerRadius` / `paddingX` / `paddingY` / `offsetX` / `offsetY` | text | | enabled no, rest yes |
| `fill`, `stroke`, `strokeWidth`, `strokeAlign`, `cornerRadius`, `points`, `depth`, `sides` | graphic (per shape) | | yes |

Values are coerced by `coerceParamValue` (`params/index.ts:309`): numbers snapped to `step` then clamped; selects must be
an option; wrong types are refused.

## 6. Animations (`animation/types.ts`)

`element.animations` is `{ [propertyPath]: ChannelData }` (`:111`). A path is an element param key
(`"transform.positionX"`, `"opacity"`, `"volume"`…), `params.<key>` for graphic params or
`effects.<id>.params.<key>` for effect params (`:22-23`).

- **Leaf** channel (numbers, booleans, strings): `{keys: [...]}` stored directly under the path.
- **Composite** channel (colours): `{r: {keys}, g: {keys}, b: {keys}, a: {keys}}` (`params/index.ts` COLOR_CHANNEL_LAYOUT).
- Scalar key (`:69`): `{id, time (ticks, element-relative), value, segmentToNext: step|linear|bezier, tangentMode,
  leftHandle?, rightHandle?}`; handles are `{dt: ticks, dv}` relative to their key, clamped to the neighbouring span.
  A bezier segment without handles is a straight line (default handles at 1/3, `animation/bezier.ts:27-55`).
- Discrete key: `{id, time, value}` (holds).
- Upsert (`animation/keyframes.ts:477`): a key at the same tick is updated in place; times are clamped to
  `[0, duration]` by the command (`commands/timeline/element/keyframes/upsert-keyframe.ts`).
- Split (`keyframes.ts:1231`) cuts every channel at the split point, adds boundary keys, rebases the right half to 0;
  bezier segments are subdivided with de Casteljau. Clamp-to-duration (`:887`) is "split and keep the left".

## 7. Everything else

- **Effects** (`effects/types.ts:3`): `{id, type, params, enabled}` on visual elements. Upstream registered only
  `blur`; RestorffCut adds Digital Zoom, Vertigo, Glass Type and (grade agent, 2026-10-20) **`restorff-grade`**, the
  colour grade: params = the sliders of `src/grades.ts` + a `look` string. ops@1 `grade` writes it into a clip's
  `effects`, or as an effect element on a `GRADE` effect track (`restorff.role: "grade"`) for the whole timeline. No
  LUT loader. No project-version change (the shape was already in v31/v32).
- **Masks** (`masks/types.ts:134`): split, cinematic-bars, rectangle, ellipse, heart, diamond, star, text, freeform. Not
  animatable. ops@1 has no mask op; the reducer carries masks through untouched.
- **Captions** are ordinary `text` elements on a text track, named "Caption N" (`subtitles/insert.ts`,
  `subtitles/build-subtitle-text-element.ts:317`); there is no caption track type.
- **Audio separation** (`timeline/audio-separation/index.ts:75`): "extract" copies the video's span/trims/volume into a
  new upload-audio element on the first free audio track and sets `isSourceAudioEnabled: false`; "recover" only sets it
  back to true (the extracted element stays).
- **Ripple** is a mode, not a command (`core/managers/commands.ts:14`): after any command, freed intervals on a track
  shift that track's later elements left (`ripple/diff.ts`, `ripple/shift.ts:3`).
- **Bookmarks** (`timeline/types.ts:12`): `{time (frame-rounded), note?, color?, duration?}`, sorted by time.
- **Added in v32 (2026-10-20, media agent):** `transitionIn {type, duration}` on video/image clips, `beats {bpm, times
  (source ticks), downbeats?, source}` on audio elements, `settings.loudness {enabled, integratedLufs, truePeakDb}`.
- **Not in the model at all:** colour grading, size variants,
  loudness targets, crop (other than via a mask).

## 8. Restorff's additive fields

The reducer adds three optional fields. The editor's types don't declare them; JS spreads carry them along.

| Field | Shape | Survives a browser save? |
|---|---|---|
| `metadata.restorff` | `{opsVersion: "ops@1", pending: PendingInstruction[], media: MediaManifestEntry[]}` | **No** — `saveProject` rebuilds `metadata` from named fields (`service.ts:149-156`). See open question 1 in README. |
| `track.restorff` | `{role?: "caption" \| "sfx" \| …, createdBy?}` | Yes — tracks are stored as-is (`service.ts:142`) |
| `element.restorff` | `{createdBy?, author?, role?: "caption" \| "text_pop" \| "sfx"}` | Yes, and commands spread elements, so split/move keep it |

`author` on an element is the author of the last op that changed it — what the Edit artboard's "Author" row shows.

## 9. Invariants the reducer guarantees

Checked after every op by `checkInvariants` (`src/scene.ts`); an op that introduces a new violation is rejected
(a project that arrives with old violations can still be edited):

1. The main track exists and is a video track; overlay groups hold no audio track, the audio group only audio tracks.
2. Track ids and element ids are unique in the scene.
3. Every element sits on a track of its type.
4. `startTime`, `duration`, `trimStart`, `trimEnd` are integer ticks; `duration > 0`; nothing negative.
5. With a known media length: `trimStart + round(duration × rate) ≤ sourceDuration` (±1 tick for retime rounding).
6. No two elements on one track overlap (half-open spans; touching is fine).
7. Every keyframe time is an integer in `[0, duration]`.
