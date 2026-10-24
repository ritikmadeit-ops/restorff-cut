---
id: sound
title: Sound
summary: When a piece gets music and effects, the voice or the music as the clock, writing for the local voice, the music bed, sound effects only on visible actions and placed on their peak, levels and loudness, and saying it was measured not heard.
read_when: Before adding voice-over, music or sound effects, and before delivering anything over about 15 s.
aliases: audio, sfx, music, voiceover, voice-over, voice, bed, mix, levels, loudness, ducking, whoosh
tools: voiceover, music, sounds, timeline_ops, check
related: pacing-retention, captions, story, qa-loop
next: sounds list | List the SFX pack (length, sync point, suggested level) before placing sounds.
source: skills/hyperframes/references/{sound,film}.md; skills/media-use/audio/references/{sfx,bgm}.md; skills/media-use/references/{mixing,audio}.md; .claude/skills/changelog-video/references/{script-voice,build-spec}.md; docs/prompting/{media-and-audio,audio-effects,music-and-slideshows,capstone,vocabulary}.mdx; docs/guides/{voice-and-audio,music-to-video}.mdx; docs/reference/audio-effects.mdx
---
# Sound

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{sound,film}.md, skills/media-use/audio/references/{sfx,bgm}.md, skills/media-use/references/{mixing,audio}.md, .claude/skills/changelog-video/references/script-voice.md, docs/prompting/{media-and-audio,audio-effects,music-and-slideshows,capstone}.mdx, docs/guides/{voice-and-audio,music-to-video}.mdx @fa5dbd1; modified for RestorffCut.

## The default
Sound is half of how a video feels, and every judge of frames misses it.
- A piece **over about 15 s that tells something** (ad, launch, explainer, recap) gets a music bed and sounds on its
  visible actions, unless the person asked for silence or it is made to play muted (a looping background).
- A **voice-over** only when the request or the source calls for one.
- Short pieces (a title card, a sting under 10 s, captions on footage with its own sound) follow the request and the
  footage. "No narration" is not "no audio".
- Each storyline states its sound in one line: the bed's feel and tempo, the one moment the music changes, which
  actions get effects, or silence and why. Let the sound act out the story: the old way near silence, the music opens
  when the product appears, or holds back until the payoff.

## The clock
- **Narrated: the voice is the clock.** Each beat starts on its anchor word; text lands on the word that says it;
  the narration never waits for pictures. A new voice take re-opens every seam it touches.
- **Music only: the music is the clock.** Land the payoff and the mark on strong beats; cuts follow the picture's
  motion, not the drums (`guide pacing-retention`, "Cutting to music").

## Voice-over with the local voices
`voiceover {timeline_id, text, voice?}` says ONE line per call with this machine's speech engine (free, offline; it
sounds robotic next to a paid voice: say so to the person) and returns its word timings, which captions read.
- Write for the ear: sentences of at most ~14 words; pauses with commas and dashes, never ellipses or capitals;
  numbers as they should be said ("eighteen hours"); initialisms spaced ("C B D"); acronyms said as words respelt;
  never speak a version number, a URL or a code. Keep the display text and the spoken text separate when they differ.
- About 2.2 words a second; ~19 words per scene. `tighten: true` cuts pauses over 0.35 s (these voices leave ~0.8 s
  after each sentence). `fit_to {t0, t1}` (or `{beat: N}`) speeds a line into its span or refuses; it never overruns.
- `beat: true` puts the first word on the next downbeat of the music.

## Music
`music {timeline_id, mood}` places a generated bed (ours, free to ship): `warm`, `moody`, `upbeat`, `ambient`, `tense`
(`music {action: "list"}` shows the beds and BPM). It loops seamlessly under the cut, carries a beat grid (for
`snap_cuts`), sits at about −22 LUFS under a voice and −18 alone, and ducks under the voice's words automatically.
- Choose by the piece's feel and tempo, not its subject: an ad's hook wants energy from the first bar; a brand film
  can breathe. Calm 90–110 BPM, energetic 110–130.
- The bed enters strong (a quiet build drains a short piece) and ends on a bar with a short fade under the end card,
  never at the file's edge. `loop: true` gives whole bars and no fades, for a cut that loops.
- The person's own track always wins; theirs comes in with `media import`.

## Effects: few and exact
Every effect has a cause on screen; too many read as a template. `sounds list` shows the pack (27 sounds, e.g.
`whoosh-short` 0.45 s, `swish`, `whoosh-hit`, `riser-1s`, `riser-2s`, `impact`, `sub-hit`, `boom`, `pop` 0.12 s,
`click`, `tick`, `typewriter-key`, `typing-burst`, `stamp-slam`, `marker-scribble`, `paper-slide`, `paper-rustle`,
`camera-shutter`, `glitch`, `tape-stop`, `record-scratch`).
| Sound | Only on |
| --- | --- |
| click | a real cursor click on screen |
| whoosh / swish | a scene cut, or a large card moving fast |
| tick / typewriter key | text arriving letter by letter or line by line; a counter's steps |
| pop | a badge, chip, word or number landing |
| stamp, marker, paper | the stamp landing, the line being drawn, paper being cut or lifted |
| riser into impact | the payoff or the mark, **once** in the piece |
- **Peak one frame after the picture** (light arrives before sound; a sound early feels wrong sooner than one late).
  `sounds place` lines up the sound's EVENT (a whoosh's peak, a hit's attack) with `t`, so give `t` = picture time
  + 1 frame (0.033 s at 30 fps).
- Each hit sits 3–6 dB over the bed. A bed with most of its energy under 150 Hz plays as nothing on a phone speaker.
- Rotate two or three different sounds for a repeated action; the same whoosh on every cut is the most common tell.
- Over strong music, a typing-heavy piece can drop the clicks and keys. No synthesised tones or dings as decoration.
- `sounds design {timeline_id}` does a first pass for the whole cut: a hit at 0 s, a riser into the end of the hook,
  a hit on every real cut, sounds on the cues compositions declare (typing, stamps, markers, scene cuts), pops on text
  that arrives away from a cut, at least 0.25 s apart, music ducked 3 dB under them. Read what it placed; remove what
  has no cause. Compositions should declare their cues (`guide composition-authoring`, "Declarations").

## Levels and loudness
- Music under a voice: around 0.12–0.14 of full volume (≈ −18 dB), ducked about 10–12 dB while anyone speaks (the
  `music` tool does this; `timeline_ops duck {track, under, amount_db}` for your own audio), back up after.
- Sound effects sit under the voice; nothing clips. Clip level: `timeline_ops gain {el, db}`.
- Delivery: **−14 LUFS ± 1** integrated, true peak **≤ −1 dBTP** for social (`timeline_ops normalize {lufs: -14,
  true_peak: -1}` records the target; the final render masters to it; `check` measures it).
- A bed that starts before the voice keeps full level until the voice starts.
- Equalising a voice (rumble, boom, harshness) is not available over MCP today (UNVERIFIED for later: high-pass ~80–120
  Hz for rumble, −4 dB at 200 Hz for boom, +2.5 dB at 3 kHz for clarity, −3 dB at 3.2 kHz for harshness).

## You cannot hear it
`check` measures loudness and where sound is; it cannot judge taste. In the delivery note say the sound was measured,
not heard. Check: voice clear through the loudest musical moment; no surprise at the open; hits where the picture hits;
the music ends on purpose. Many viewers watch muted: the picture and captions must carry the piece alone.
