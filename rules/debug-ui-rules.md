# UI Panel And Debugger Rules

**Scope:** the injected page panel and the always-live debug panel — structure, named areas,
resource diagnostics, and anonymized export rules. This is a **map** (where-to-look + guardrails),
not a rebuild narrative.

> Cross-links: runtime-playback debug fields are defined in `rules/audio-rules.md` §6; sync/mutation
> debug stages in `rules/wishlist-and-collection.md` §7; tempo-decision fields in
> `rules/bpm-analysis-rules.md` §8.

## UI

- The custom panel is injected into the Bandcamp page DOM by `src/ui/panel.ts`.
- This is not an extension popup.
- Component files live in `src/ui/components/`.
- Styles live in `src/ui/styles.ts` and `src/ui/styles/`.
- Keep UI changes consistent with existing components and the injected-page constraints.

## Debugger UI

The debug panel is always live when the content script is running. Users can open it from the info menu or with Alt+D.

The panel renders one global trace record as expandable areas with per-area copy buttons plus Copy All. Do not reintroduce separate "state" and "activity" panes or an Activate/Deactivate gate.

Keep page context, playback, analysis, performance, runtime preparation, playback handover, and transport diagnostics in their named areas. Trace continuation lines belong with their heading rather than in a catch-all section.

The Performance area also hosts task-manager-style resource diagnostics (`Resource …` rows: per-context event-loop lag, feature-detected JS heap, worker busy fraction, WASM/cache bytes, audio-host underruns). Sampling is gated entirely on the panel being open — every context starts sampling on panel-open and stops on close (session-based, with a stale-prune backstop), so there is zero idle overhead during normal playback. Heap values use `heap`/`heapLimit`/`wasmHeap`/`essentiaHeap` tokens so the anonymized export can redact them; never rename those tokens or emit raw memory under a different key.

`heap` comes from `performance.memory`, which is **process-wide**, not per-context. Chrome co-locates the offscreen document and the runtime-audio host iframes in one extension renderer process, so those rows repeat the same heap figure (and correlated lag) — do not sum them. The content script runs in the page's own process and reports a separate heap. On Firefox `performance.memory` is absent, so heap shows `-`; there the event-loop lag is the primary signal (Firefox shares one audio thread across AudioContexts).

Routine Discover DOM/epoch replay rows should stay collapsed to summaries and only print per-item rows for unresolved or mismatched state.

The top status strip MUST continue to reflect current state while the pointer is over the panel, even when the expandable trace content is held stable for reading or selection.

The anonymized copy export MUST omit account/fan identity, library and authentication details, local paths, device-identifying values, browser-audio details, and signed URL tokens while retaining played-track and operational diagnostics needed for support.

## Debug Requests

When runtime state matters, ask the user for the specific debugger copy output needed before behavior changes. Give exact before/after capture instructions:

- Browser and page context.
- User action to perform.
- Debugger area to copy, or Copy All.
- Whether the capture is needed before the change, after the change, or both.

## Debug Fix Map

| Problem | Look in |
|---------|---------|
| UI panel issue | `src/ui/panel.ts`, `src/ui/components/`, `src/ui/styles/`. |
| Debug panel structure issue | `src/content/debug/debugger.ts`, `src/content/debug/debug-body.ts`, Discover debug modules, and `src/ui/debug-panel/`. |
| Debug surface missing needed state | Add targeted state visibility instead of broad logging spam. |
| Runtime playback debug issue | Start with `rules/audio-rules.md`, then inspect `src/content/player/runtime-audio/`, `src/runtime-audio-host.ts`, and debug fields named in the runtime audio reference. |

## Change Rules

- Use existing debug surfaces first. If missing state blocks safe reasoning, improve the debugger as part of the task.
- Debug output must reflect runtime behavior after behavior changes.
- Do not log secrets, signed URL tokens, local paths, account identity, or device-identifying details in copy exports.
- Prefer targeted diagnostics that explain the state transition over broad console noise.
