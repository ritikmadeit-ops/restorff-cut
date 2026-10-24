# knowledge/ — the playbooks RestorffCut serves over MCP

**What.** The craft know-how a model needs to make a video *good* with RestorffCut, not just *possible*: the work loop,
story, motion, transitions, type and layout, captions, pacing and retention, sound, grade, numbers, the video types,
how to write a composition, the animation runtimes, and the QA loop. One markdown file per topic, written for any
model (a smaller one, or another vendor's: plan/INBOX I-8), in **our** tool names, params and flows.

**Who reads it.** Any MCP client, through the `guide` tool (`apps/web/src/mcp/guide.ts`, server code
`apps/web/src/server/knowledge.ts`): `guide {}` = the topic index; `guide {topic}` = one playbook; `guide {topic,
section}` = one `##` section of it; `guide {query}` = where a word is covered. One topic per call, never all of them.
The server instructions and the composition / effects / captions / sounds / look tool descriptions point here.

**Where it came from.** Adapted from HyperFrames' agent skills and docs (HeyGen, Apache-2.0,
`github.com/heygen-com/hyperframes` at commit `fa5dbd1`), rewritten for RestorffCut's tools wherever their tool
names or flows differ from ours, merged where several of their files say one thing, and with our own measured facts
added. Every playbook names its sources in its `source:` line and in its credit line. The file-by-file inventory
(what each of their 106 skill files and the docs teach, and what was applied, merged or skipped, and why) is in
`docs/restorff/worklog/hf-skills.md`. Licence: Apache-2.0 for the adapted parts (NOTICE at the repo root); our own
additions are under the repo's licence.

**The structured side.** The director agent's technique records (`src/technique*.ts`, `TECHNIQUES.md`) say *which*
effect fits *which* beat as data; these playbooks say *how to do it well* as prose. A record links here through its
`knowledge` field (`knowledge/<topic>.md`); a playbook links to records by id only. Never copy one into the other.

## File contract (the server parses this; `src/server/__tests__/knowledge.test.ts` checks it)
```
---
id: motion                          kebab-case, = the file name without .md
title: Motion craft                 a name, not a sentence
summary: one line: what the playbook covers
read_when: one line: when a model should read it
aliases: easing, ease, stagger      optional, other words a client may ask for
tools: composition, timeline_ops    the MCP tools the playbook uses
related: transitions, typography-layout
next: composition contract | Read the live contract, then write the piece.     tool + action | the do-line
source: skills/hyperframes/references/motion.md; .claude/skills/cut-the-curve/SKILL.md
---
# <title>

Adapted from HyperFrames skills (Apache-2.0) <paths>@fa5dbd1; modified.

## Section …
```
- The body (everything after the front matter) is at most **12,000 characters**; a `##` section at most **6,000**.
  The index answer is at most **6,000**. Over that, split the topic. Tests fail otherwise.
- `##` headings are the sections a client can ask for: short, unique within the file.
- Numbers come with units. Our tool and param names only (`effects apply`, `timeline_ops keyframe`, `RC.progress`,
  `captions {style: "key-word"}`); a HyperFrames command name never appears as an instruction.
- Mark what is not measured here: **ASSUMPTION** (a call we made) or **UNVERIFIED** (stated by the source, not
  checked on RestorffCut).
- No third-party marks in examples (no platform, app or company names); fictional Halcyon Cold Brew only.
- `README.md` is not a topic.

## Add or change a topic
1. Write or edit `knowledge/<id>.md` to the contract above.
2. `cd apps/web && bun test src/server/__tests__/knowledge.test.ts` (front matter, sizes, related ids exist, index size).
3. Live check (dev server on :8791): `bun scripts/mcp-call.ts call guide '{"topic":"<id>"}'` from `restorffcut/`.
   The server re-reads the files when they change (no restart).
4. If a director record should link it, tell the director (its worklog) the path.
5. A CHANGELOG line in `packages/compositions/CHANGELOG.md`.
