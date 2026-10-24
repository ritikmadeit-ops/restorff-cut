---
id: captions
title: Captions
summary: The caption model (drop, rail, embed), group sizes by energy, choosing a caption style from the tone, key words, placement as an overlay, legibility over footage, text behind the speaker, and checking the transcript first.
read_when: Before captioning any speech, restyling captions, or putting a big word behind the speaker.
aliases: caption, subtitles, subtitle, karaoke, key-word, keywords, text-behind, transcript, word-pop
tools: transcribe, captions, cutout, revise
related: typography-layout, pacing-retention, sound, motion
next: captions | Caption the timeline with dry_run first: captions {timeline_id, all: true, style, dry_run: true}.
source: skills/hyperframes/references/captions.md; skills/media-use/audio/references/captions/{authoring,motion,transcript-handling}.md; .claude/skills/captions-overlay/SKILL.md; docs/prompting/{captions-and-talking-heads,captions-catalog,vocabulary}.mdx; docs/guides/{captions-and-recuts,voice-and-audio}.mdx; skills/hyperframes-registry/references/{contributing,templates}.md
---
# Captions

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/captions.md, skills/media-use/audio/references/captions/*, .claude/skills/captions-overlay, docs/prompting/{captions-and-talking-heads,captions-catalog,vocabulary}.mdx, docs/guides/{captions-and-recuts,voice-and-audio}.mdx @fa5dbd1; modified for RestorffCut.

## The transcript comes first
`transcribe {all: true}` (poll the same call until done) gives every word's start and end; `voiceover` puts its own
words in the same store. Read the transcript before captioning:
- More than 20 % music-note or garbage tokens, or nonsense words, means it failed on music or noise: say so, and ask
  for the lyrics or a cleaner take rather than captioning nonsense.
- Speech models invent "Thank you." over silence and repeat lines over a silent tail: drop words that start inside a
  final silence.
- Names, product terms and numbers are where transcripts go wrong. Fix them with `transcribe {action: "edit", fixes:
  [{from, to}]}`; captions rebuild with the fix and every rebuild keeps it.
- Two speakers or hard cuts: caption per clip (`element_id`), not across the cut.

## The caption model: drop, rail, embed
Every spoken phrase is one of three things:
| Kind | What | How it shows |
| --- | --- | --- |
| drop | filler: um, uh, stutters, self-corrections | not shown (autocut removes most) |
| rail | the default: ordinary speech, verbatim | the caption line, in front, readable; a punch word may get an inline accent |
| embed | a promoted peak, the headline beat | one big word behind the speaker (`cutout`), with a designed entrance and exit |
The rail carries most of the text; the embed is scarce and earned: at most one per beat, never two visible together,
at least a beat apart. A short clip usually has one; an explainer about one per section. Embedding every word is the
common mistake.
Captions are an **overlay**, not a reserved band: keep the composition on the true centre, let content run to the
bottom; only avoid parking critical small text (a price line, a legal line) exactly where the caption line sits.

## Groups
- 2–3 words for high energy, 3–5 conversational, 4–6 calm (`words_per_chunk`, 1–5; default 3). Break at a sentence
  end, at a pause of 150 ms or more, or at the word limit.
- One group visible at a time. A group opens at or before its first word and closes at or after its last; a caption
  at exactly 0 s looks pre-existing (start 0.1–0.3 s in). The last caption clears before the video ends.
- One caption identity per section; vary the highlight, not the style, from group to group.

## Pick the style from the tone
Read the whole transcript, then match the tone (`captions {style}`; styles: `word-pop`, `bold-white`, `serif-box`,
`mono-label`, `huge-centred`, `key-word`):
| Tone | Style | Size on 1080×1920 | Motion character |
| --- | --- | --- | --- |
| Hype, launch, viral reel | `word-pop` or `key-word`, heavy caps | 72–96 px letters (`size: "90px"`) | scale pop, fast |
| Ad with one claim per line | `huge-centred` for the claim lines (t0/t1 span), `bold-white` for the rest | 96 px+ for the claim | slam in, hold |
| Corporate, product | `bold-white` | 56–72 px | fade and settle |
| Tutorial, technical | `mono-label` | 48–64 px | type-on, high contrast |
| Storytelling, brand film | `serif-box` | 44–56 px | slow fade, warm |
Sizes are letter heights the source measured for its tones (UNVERIFIED against our styles' own defaults: `captions
{action: "measure"}` reports what is on the timeline; the tool's own scale is `size: 5` ≈ 107 px letters).
Don't put hype styles on calm content. Size, case, colour and zone are restyles: `captions {size: "1.35x", case:
"upper", key_color, zone}`; with `t0`/`t1` only that span changes. `captions {action: "measure"}` lists sizes by span;
`{action: "unify"}` gives each mixed span one size.

## Key words
Emphasis on key words only, never every word. Candidates: the brand or product name, numbers and statistics (bold,
accent), ALL-CAPS words, emotional words (a stronger animation), the call to action. `captions {style: "key-word",
keys: ["eighteen", "smooth"]}` or `keys: "auto"` (one telling word per chunk); `key_color` sets the accent. With
`word-pop`, `key_color` recolours the word box. A key word always breaks the pattern of the words around it (bigger,
accent, overshoot), which is why it must be rare.

## Placement and legibility
- `zone: "auto"` keeps captions clear of the face when the clip has a person matte (`cutout matte`); without a face
  box yet, chunks go to the top band and the matte is started; caption again when it finishes. Never over the
  speaker's face or key UI. Inside the safe area (the captions tool measures it like the export gate does).
- Over footage choose by the brightness behind the text: dark backgrounds take light type; above ~180 of 255 use
  near-black opaque type; plain captions over mid-bright footage get a scrim sized to the text (30–40 %), never a
  full-width bar.
- Footage that already carries burned-in subtitles somewhere: look at a contact sheet before placing yours.
- Watch it once with sound and once muted: the muted pass is how most of the audience sees it.

## Text behind the speaker
The embed: a big word between the footage and a cut-out of the person. `cutout matte {element_id}` → `cutout status`
until done → `cutout apply {preset: "text_behind_person"}`. Rules that hold:
- A big word behind the head reads best **30–55 % covered**: under ~15 % it floats in front, over ~65 % it is eaten.
  Re-lay it out when a content word is 80 % covered, or two neighbouring words 50 % each. Heads move: judge the cover
  over the word's whole window (look at stills at its start, middle and end), not one frame.
- Punch in or shake the footage and the cut-out together, never one without the other. Never lay a cut-out over a
  different take of the same person (two overlapping people).
- The matte model is people-only: it drops held objects and mic arms, struggles with hair on busy grounds, and
  flickers on objects held near the body. If the edge is poor in the frames you looked at, choose another moment or
  keep the word in front.

## Music, lyrics and moving captions
Lyrics on screen only when asked; then each line holds at least a beat and is set as type, not subtitles. Captions
over music may move with it, subtly: 3–6 % scale and a soft glow on loud groups; heavy pulsing makes text unreadable.

## Checks before you render
Every spoken interval has a caption (a missing one is a hard fail); the last caption clears before the end; no
caption sits over a face or key UI; key words are rare and meaningful; one style per section; read every caption at
phone size in `look` stills. `revise "change 'Cloud' to 'cold'"` fixes one word; revise never deletes caption words
nobody asked to remove.
