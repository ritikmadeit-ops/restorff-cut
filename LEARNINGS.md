# restorffcut — LEARNINGS

Rules something paid for. Each carries its date, the incident and the cost; a rule with no incident is an opinion.

## 1. Check the .com before you name a product
**2026-10-14.** This repo was scaffolded as `cutcritic/`. The same day, spike S5 found `cutcritic.com` already used by
a live, pre-launch product doing the same job, and the editor was renamed RestorffCut (D12). The cost was small only
because nothing public used the name yet. **Rule:** a name screen (trademark register + RDAP + fetch the `.com`) comes
before a repo, a package name or any copy (`../plan/LEARNINGS.md` §8).

## 2. An editor's pacing targets are measured off approved human edits, not chosen
**2026-10-22.** Imported from a working ad editor's kit (70 files, handed over after an ad was rejected). Every
number below was measured off edits the client actually approved, not picked:

| | verified |
|---|---|
| Body shot, average | 2.01 s |
| Body shot, **median** | **1.67 s** |
| Body cuts per 10 s | **5.0** |
| Body shot range | **0.53 – 4.03 s** |
| Hook shots | 0.8 – 1.4 s, 7.0 – 7.8 cuts / 10 s |
| Per sentence | 1–3 shots; a 3.3–4.0 s line becomes 2 shots |
| Long VSL (3–10 min) | avg shot 3–7 s, a text card roughly every shot |

**Why it matters here:** an ad we built measured median 1.62 s / 5.66 cuts per 10 s — inside these numbers — and
the client still called the edit "choppy". The deviations were not the *rate* but (a) shots **below the 0.53 s
floor** (we shipped one at 0.30 s and several at 0.52 s) and (b) flash inserts that were flat stills with a fake
push-in rather than footage. **Rules for autocut:** enforce a **minimum shot length of 0.53 s** — anything shorter
is a flash, not a shot; count a still-with-a-move as a still, not a shot, when reporting rhythm; and report cuts
per 10 s against a **band** (floor *and* ceiling), because a rule with only a floor cannot fail a cut for being
too choppy, which is the failure mode people actually complain about.

## 3. Trimming pauses: neither word timings nor silence detection is trustworthy alone
**2026-10-22.** Two findings that bound each other, both paid for:

- **Word timings can be badly wrong.** Trimming a clip's head to `first_word − 0.30 s` deleted a line's opening
  word, because the transcriber placed it 0.87 s late. It was in the source and absent from the render.
- **Silence detection is defeated by ambience.** The imported kit records the opposite failure: clips with room
  tone never register silence, so a silence-driven cut removes nothing and the edit drags.

**Rule:** a cut that removes audio is defined by the audio and cross-checked against the words. Head trim =
`min(first_word − 0.30, measured_onset − 0.10)`. Interior pauses = measured silence over 0.45 s (merge stretches
that the detector splits when the signal flickers over the threshold). If the detector finds **no** interior
silence while the words show gaps over 0.45 s, fall back to the word gaps narrowed by −0.15 / +0.35 rather than
cutting nothing. **Leave silent B-roll at full length.** Never cut mid-word or mid-sentence; a voice piece holds a
whole phrase from first word to last, and a J/L offset shifts only the picture cut (0.1–0.2 s), never overlapping
two different voice lines. After building, transcribe the rendered voice and check it reads exactly like the
script — no repeats, gaps or swapped lines.

## 4. Caption style is per concept, and comes from the reference
**2026-10-22.** The kit's rule: caption style is chosen per concept — from the brief, the reference video, or what
the client used on that concept — **never fixed by brand**. Its user-confirmed spec for short-form hook/body ads is
white **bold** text with a **black outline and no box**, size 8, **3–4 words a card**, 0.4–2.1 s a card (avg
1.06 s), one card per spoken phrase, **no cards over silence**, no per-word colour and no keyword highlight.

**Cost of not knowing this:** we shipped large orange/white ALL-CAPS cards with a coloured keyword per line and
~8 words a card, on an ad whose own two reference videos both use small clean white captions. It read as a
different, cheaper genre. **Rule:** derive caption style from the reference before writing a single card, and
treat "our house style" as a fallback only when there is no reference and no prior.
