# apps/web — Restorff notes

What RestorffCut's web app adds on top of the editor it was built from. Build log and open issues for the project store:
[`../../docs/restorff/worklog/port.md`](../../docs/restorff/worklog/port.md).

## API — the project store (commits, branches, comments, share links)

The server keeps every project as a chain of **commits**: each commit is a full project JSON snapshot (the editor's
`SerializedProject`, schema v31, times in ticks of 1/120 000 s) plus, optionally, the `ops@1` batch that produced it.
A **branch** is a named head (`main` by default). Claude (through Restorff's gateway) pushes commits; the editor pulls
them; the editor's own saves come back as commits by `user`.

### Run it
```
cd apps/web
bun run dev                      # http://localhost:8791; the store opens on first API call
bun scripts/api-smoke.ts         # 39 checks against the running server; ends "all 39 checks passed"
```
Data: `apps/web/.data/pglite` (PGlite = Postgres in WebAssembly) and `apps/web/.data/media/<sha256[0:2]>/<sha256>`
(uploaded media), both git-ignored. No Docker, no database server. New migrations are applied on the next API call,
even on a dev server that is already running.

### Env vars
| Var | Default | Meaning |
|---|---|---|
| `RESTORFFCUT_SERVICE_TOKEN` | unset | Bearer token for machine writers (the gateway). Unset = no machine access outside local dev. |
| `RESTORFFCUT_DB` | `pglite` in dev; `postgres` when `NODE_ENV=production` and `DATABASE_URL` is set | Store driver: `pglite` or `postgres`. |
| `DATABASE_URL` | (from `.env.local`) | Postgres URL, used only when the driver is `postgres`. Dev's `.env.local` carries a placeholder with nothing listening, which is why dev defaults to PGlite. |
| `RESTORFFCUT_DATA_DIR` | `<apps/web>/.data/pglite` | PGlite data folder. One server process per folder (a `.lock` file holds the pid). |
| `RESTORFFCUT_LOCAL_DEV` | on | `0` turns off local dev mode (no-auth on localhost). |
| `RESTORFFCUT_PUBLIC_URL` | request origin | Base for share URLs returned by `POST /api/share`. |
| `RESTORFFCUT_MEDIA_DIR` | `<apps/web>/.data/media` | Uploaded media files (content-addressed). |
| `RESTORFFCUT_MEDIA_MAX_MB` | `2048` | Largest accepted upload. |

### Auth
- **Service** (the gateway): `Authorization: Bearer $RESTORFFCUT_SERVICE_TOKEN` (constant-time compare). May commit as
  any author. A wrong token is `401`, never a fall-through.
- **Browser users**: the better-auth session cookie when auth is configured; they always commit as `user` (else `403`).
- **Local dev mode**: `NODE_ENV` ≠ production, request addressed to `localhost`/`127.0.0.1`, no proxy in between → no
  auth. Every response says which mode served it: header `X-RestorffCut-Auth: service | user | local-dev`.
- `GET /api/share/:token` and `/api/share/:token/comments` are public: the token is the credential.

### Objects
```ts
commit  = { id /* 40 hex */, project_id, parents: string[], branch, author: "user"|"claude"|"compiler"|"preset",
            author_name, message, snapshot_hash /* sha256 of the cut, ignoring updatedAt/thumbnail/view state */,
            summary: { tracksAdded, tracksRemoved, elementsAdded, elementsRemoved, elementsModified,
                       settingsChanged, renamed, lines: string[] } /* vs first parent */,
            stats: { duration_s, track_count, element_count }, ops_count, seq, created_at,
            snapshot?, ops? /* only on GET one commit */ }
comment = { id, project_id, commit_id, share_link_id, time_s, time_end_s, track_id, track_name, element_id,
            author, body, rule_id, severity: "must"|"should"|"could"|"info"|null, status: "open"|"resolved",
            parent_id, finding_id, resolved_by, resolved_at, created_at }
```

### Endpoints
| Method · path | Body / query | Success | Errors |
|---|---|---|---|
| `POST /api/projects` | `{snapshot, id?, name?, author?, message?, branch?, ops?}` (id defaults to `snapshot.metadata.id`) | `201 {project, commit}` | `409` id exists · `400` |
| `GET /api/projects` | — | `200 {projects[], store}` | |
| `GET /api/projects/:id` | `?branch=main` | `200 {project, branch, head, snapshot}` | `404` |
| `GET /api/projects/:id/commits` | `?branch=` `?since=<commit>` `?limit=100` `?all=1` | `200 {branch, head, commits[]}` newest first, first-parent; `since` stops before that commit | `404` |
| `GET /api/projects/:id/commits/:commit` | full id or unique prefix ≥ 4 | `200 {commit}` with `snapshot` + `ops` | `404` |
| `POST /api/projects/:id/commits` | `{base_commit, branch?, author, ops?, snapshot, message}` | `201 {commit, branch, created_branch}` | **`409 {error, conflict: {branch, head, since[], base_found}}`** when `base_commit` is not the branch head · `400` · `403` |
| ″ ops-only | same, **without `snapshot`**: the server applies `ops` to `base_commit`'s snapshot with `@restorffcut/timeline-ops` (seed `<project>/<base>`) | `201 {commit, branch, created_branch, changes}` | `422 {error, conflicts, changes}` reducer refused, nothing committed |
| `GET /api/projects/:id/branches` | — | `200 {default_branch, branches: [{name, head, updated_at}]}` | |
| `POST /api/projects/:id/branches` | `{name, from_commit?}` | `201 {name, head}` | `409` exists |
| `GET /api/projects/:id/comments` | `?commit=` `?status=open\|resolved` `?finding=1` | `200 {comments[]}` by time | |
| `POST /api/projects/:id/comments` | `[finding@1, …]` · `{findings: [finding@1…], commit_id?}` · or one comment `{time_s, body, author?, track_id?, track_name?, element_id?, rule_id?, severity?, parent_id?, commit_id?}` | `201 {comments[], errors[]}` (`400` if none stored) | |
| `PATCH /api/projects/:id/comments` | `{id, status?, body?, resolved_by?}` | `200 {comment}` | `404` |
| `GET /api/projects/:id/media` | — | `200 {media: [{media_id, hash, size, mime, meta, updated_at}]}` | |
| `PUT /api/projects/:id/media/:mediaId` | raw file body; headers `Content-Type`, `X-Media-Meta` (base64url JSON of the editor's MediaAssetData, optional), `X-Media-Sha256` (optional check) | `201 {media}` — same bytes stored once (sha256) | `413` > `RESTORFFCUT_MEDIA_MAX_MB` (2048) · `400` |
| `GET /api/projects/:id/media/:mediaId` | `Range: bytes=a-b` honoured | the file (`200` / `206`) | `404` · `410` file missing |
| `POST /api/share` | `{project_id, commit_id?, branch?, can_comment?, expires_in?: "1h"\|"24h"\|"7d"\|"30d"\|"never", expires_at?}` | `201 {token, url, editor_url, link}` — the token is shown only here | `404` |
| `GET /api/share?project_id=` | — | `200 {links[]}` (no tokens) | |
| `DELETE /api/share?id=<link id>` | — | `200 {link}` (revoked) | `404` |
| `GET /api/share/:token` | `?view=1` counts a view | `200 {link, project, commit, head, snapshot, comments[], media: {mediaId: {mime, size}}}` | `404` unknown, expired or revoked |
| `GET /api/share/:token/media/:mediaId` | `Range` honoured | the file, for the review player | `404` |
| `GET /api/share/:token/comments` | — | `200 {comments[]}` | `404` |
| `POST /api/share/:token/comments` | `{author, body, time_s, time_end_s?, track_id?, element_id?, severity?, parent_id?}` | `201 {comment}` | `403` view-only link |

**Optimistic concurrency.** A push names `base_commit`; it lands only if that is still the head of `branch`. On `409`,
`conflict.since` lists the commits you have not seen (newest first) and `conflict.head` is the head to rebase on: GET
it, re-apply your ops, push again. Pushing to a branch that does not exist creates it from `base_commit`.

**Findings → comments** (`docs/restorff/EXPORT-GATE.md` §3–4). Each `finding@1` becomes a comment: `rule_id = rule`,
`severity`, `time_s = t`, `time_end_s = t_end`, `body = "message → fix"`, `author = source`. Status `open`, `candidate`,
`confirmed` → `open`; `dismissed`, `fixed` → `resolved`. Re-posting a finding with the same `id` updates it. The track is
resolved by name, or by the rule when `track` is null (LOUD/FORMAT → MASTER; MIX/R12/R21/R22 → MUSIC; R4/R23 → SFX;
CAP/CAP-LEN/R18/SAFE → CAPTIONS; R3/R15 → TEXT; CLIP/LIP/CLAIM/BRIEF → V1 A-ROLL; CLEAN/R1/R5/R6/TAIL/FIRST → the
top-most visible video element at `t`), then `element_id` is hit-tested at `t` against the commit's snapshot
(`finding.commit` if the store knows it, else the request's `commit_id`, else the head of the default branch).
Malformed findings come back in `errors[]` with their index and are not stored.

### curl
```bash
B=http://localhost:8791; T="Authorization: Bearer $RESTORFFCUT_SERVICE_TOKEN"; J="Content-Type: application/json"
# head of a project (snapshot + head commit)
curl -s -H "$T" $B/api/projects/proj-halcyon-ad014
# Claude pushes ops only (the server runs the reducer)
curl -s -H "$T" -H "$J" -X POST $B/api/projects/proj-halcyon-ad014/commits \
  -d '{"base_commit":"<head id>","author":"claude","message":"hook headline","ops":[{"op":"text_pop","author":"claude","t":0.3,"text":"ONE POUR.","dur":1.5}]}'
# import Judge findings
curl -s -H "$T" -H "$J" -X POST $B/api/projects/proj-halcyon-ad014/comments -d @findings.json
# a review link that follows main
curl -s -H "$T" -H "$J" -X POST $B/api/share -d '{"project_id":"proj-halcyon-ad014","can_comment":true,"expires_in":"7d"}'
```
One Claude commit the way the gateway does it (GET head → `apply` → POST):
`bun scripts/api-smoke.ts --push-as-claude <project id> --text "ONE POUR."`

### In the editor
- `/editor/<id>` opens a project that is not in this browser from the server (head of the default branch), and
  downloads the media files the server has into this browser's media store.
- Media: after "Start version history", after each pushed commit, and before a share link is made, the editor uploads
  the project's media files the server lacks; a pull downloads files this browser lacks before reloading the cut.
- The header's commit line reads `commit <hash7> · compiler v0 + N edits by you`, or `commit <hash7> · Claude pushed:
  <message>` right after a pull; click it for the Versions panel (history, diff summaries, restore, branches, conflict
  choice). A project with no server copy reads `local draft · no commits`; "Start version history" creates it.
- Saves push a commit by `user` ~6 s after editing stops; the head is pulled on load, on focus and every 15 s.
- **Share with an editor** makes a review link (`/shared/<token>`, read-only player, comments pinned to time and track)
  and shows the editor link (`/editor/<id>`).
- Comments and findings are markers on the JUDGE row under the timeline ruler, the artboard's 14 px squares: must =
  stale (amber) filled, should = `#5A5A63` filled, info = fog outline, reviewer notes = bone outline, resolved = faded;
  the selected marker = neon with a glow; a Kiln dot marks Claude/judge ones. Clicking a marker opens the 360 px
  finding card (`src/review/finding-card.tsx`): severity · rule · time · who raised it, the finding, the fix, and
  **Jump**, **Apply fix** (only when the finding carries `fix_ops`, an ops@1 array that dry-runs cleanly, or a LOUD
  finding with the gate's measured gain) and **Resolve**. (polish agent, 2026-10-20)

Ported from OpenCut-AI (MIT, Copyright 2025 OpenCut-AI; see `NOTICE`): server version control, share links, review
comments and the review player — the mechanism, re-shaped for this project model.
