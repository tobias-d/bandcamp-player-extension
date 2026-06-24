# Debugger Rules

**Audience.** Two readers at once: a developer who wants to *understand and rebuild* the
always-live debug panel, and an LLM agent changing it. The file explains *why* the debugger
is shaped the way it is, not only where to look. Read it before touching debug structure,
named areas, resource diagnostics, or the anonymized export.

**Scope.** The always-live debug panel — its structure, named areas, resource diagnostics,
and anonymized export rules. For the user-facing injected panel see `rules/ui-rules.md`.

> Cross-links: runtime-playback debug fields are defined in `rules/audio-rules.md` §6;
> sync/mutation debug stages in `rules/wishlist-and-collection.md` §7; tempo-decision fields
> in `rules/bpm-analysis-rules.md` §8.

## Simplify First (applies to every prompt)

The debugger is large and has accreted complexity over time. Every change MUST first ask how
the debug surface can be made *simpler* — fewer areas, less duplicated trace plumbing,
tighter diagnostics — before adding anything new. Prefer targeted state visibility over broad
logging, and removal over extension.

- Use existing debug surfaces first. Only add new state when missing state genuinely blocks
  safe reasoning, and then add the *minimum* targeted view rather than broad console spam.
- If a change grows the debug surface, the final response MUST say why simplification was not
  possible.
- A diagnostic that explains a single state transition beats noise that explains nothing.

## Debugger UI

The debug panel is always live when the content script is running. Users can open it from the
info menu or with Alt+D.

The panel renders one global trace record as expandable areas plus a row of copy buttons. Do
not reintroduce separate "state" and "activity" panes or an Activate/Deactivate gate.

### Named areas

The areas, their order, and their titles are owned by `SECTION_ORDER`/`SECTION_TITLES` in
`src/shared/debug-trace.ts` — that is the single source of truth; add or rename areas there,
not ad hoc. As of this writing the areas are: Context, Playback, Metadata, Analysis,
Performance, Likes, Playlist & Preload, Resolver, Runtime Preparation, Playback Handover,
Transport & Bridge, and Unclassified (`general`). Keep each diagnostic in its named area, and
keep trace continuation lines with their heading. `Unclassified` is the deliberate catch-all
for lines that have no home yet — route new diagnostics into a real area rather than letting
them collect there.

### Copy and export modes

The button row exposes several exports, plus one per-area copy button (`Copy <area>`):

- **Copy Anonymized Debug** — the privacy-filtered report (see the anonymized-export rule
  below). This is the export to ask users for.
- **Copy All** — the full trace as plain text.
- **Copy JSON** — the machine-readable trace.
- **Copy Audio** — a compact audio-incident snapshot.

### Live, Pause, and Hold

The panel is live by default (a LIVE/PAUSED badge reflects which). Two mechanisms stop the
trace from moving under the reader, both implemented in `src/ui/debug-panel/index.ts`:

- **Pause** — an explicit Pause/Resume control freezes the trace and its event list
  (`frozenEvents`) until resumed.
- **Auto-hold** — while the pointer is inside the panel *or* a text selection is active inside
  it, new snapshots are deferred (`pendingSnapshot`) so content stays stable for reading and
  copying; the held snapshot is applied on pointer-leave.

During an auto-hold the status strip MUST keep updating (`renderLiveStatus`) even though the
expandable trace is held — see the status-strip rule below. The panel also offers a
search/filter input (with an `areas/rows` count), Clear Caches, and Clear Events.

The Performance area also hosts task-manager-style resource diagnostics (`Resource …` rows:
per-context event-loop lag, feature-detected JS heap, worker busy fraction, WASM/cache bytes,
audio-host underruns). Sampling is gated entirely on the panel being open — every context
starts sampling on panel-open and stops on close (session-based, with a stale-prune
backstop), so there is zero idle overhead during normal playback. Heap values use
`heap`/`heapLimit`/`wasmHeap`/`essentiaHeap` tokens so the anonymized export can redact them;
never rename those tokens or emit raw memory under a different key.

`heap` comes from `performance.memory`, which is **process-wide**, not per-context. Chrome
co-locates the offscreen document and the runtime-audio host iframes in one extension
renderer process, so those rows repeat the same heap figure (and correlated lag) — do not sum
them. The content script runs in the page's own process and reports a separate heap. On
Firefox `performance.memory` is absent, so heap shows `-`; there the event-loop lag is the
primary signal (Firefox shares one audio thread across AudioContexts).

Routine Discover DOM/epoch replay rows should stay collapsed to summaries and only print
per-item rows for unresolved or mismatched state.

The top status strip MUST continue to reflect current state while the pointer is over the
panel, even when the expandable trace content is held stable for reading or selection.

The anonymized copy export MUST omit account/fan identity, library and authentication
details, local paths, device-identifying values, browser-audio details, and signed URL tokens
while retaining played-track and operational diagnostics needed for support.

## Debug Requests

When runtime state matters, ask the user for the specific debugger copy output needed before
behavior changes. Give exact before/after capture instructions:

- Browser and page context.
- User action to perform.
- Debugger area to copy, or Copy All.
- Whether the capture is needed before the change, after the change, or both.

## Fix Map

| Problem | Look in |
|---------|---------|
| Debug panel structure issue | `src/content/debug/debugger.ts`, `src/content/debug/debug-body.ts`, Discover debug modules, and `src/ui/debug-panel/`. |
| Debug surface missing needed state | Add targeted state visibility instead of broad logging spam. |
| Runtime playback debug issue | Start with `rules/audio-rules.md`, then inspect `src/content/player/runtime-audio/`, `src/runtime-audio-host.ts`, and debug fields named in the runtime audio reference. |

## Change Rules

- Use existing debug surfaces first. If missing state blocks safe reasoning, improve the
  debugger as part of the task.
- Debug output must reflect runtime behavior after behavior changes.
- Do not log secrets, signed URL tokens, local paths, account identity, or device-identifying
  details in copy exports.
- Prefer targeted diagnostics that explain the state transition over broad console noise.
