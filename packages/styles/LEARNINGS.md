# Learnings — @restorffcut/styles

Rules that cost time, each with the incident that taught it.

1. **Append an explainer at the end of the main track, never at 0.** 2026-10-20: the first test built the explainer
   at `start: 0` on a project with 12 s of A-roll → 6 `overlap` conflicts on the main track. The main track is also
   magnetic to 0 when empty (`mainTrackStart` in the reducer), so a plan must keep its main-track footage continuous
   from its start. The editor passes `start = end of the main track`.
2. **A zustand v5 or `useEditor` selector must return a stable reference.** 2026-10-20 (caught in review before a
   browser run): `s.library.versions[id] ?? []` and a selector building new objects from media assets would re-render
   forever (`useSyncExternalStore` sees a new snapshot each call). Use a module-level empty constant, select the
   store's own array and derive with `useMemo`.
3. **Store op SHAPES, not whole batches, in the browser history.** A "tighter cut" can be 60 split/delete/move ops;
   repeat detection and drafting only need one op per distinct shape (`history.ts compact`).
4. **Never save an absolute value of something the style scales.** 2026-10-21 (QA 2026-10-20 #8): "Bigger captions"
   was saved as `caption_size: 20` from a project with large captions; applied to size-5 captions it drew 427 px
   letters far past the frame. A caption size is now a ratio (`style.scale`, param `caption_scale`) of the size the
   captions had before (`InstructionRecord.caption_size_before`), every size planStyle sets is capped inside the caption
   safe area in whole units (never below the current size), and old styles are migrated or flagged
   (`src/caption-size.ts`). Same rule for any future relative instruction (louder, slower, tighter).
