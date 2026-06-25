# Listening Mode — Implementation Plan

A new player mode that disables all DJ-oriented features, leaving a clean
listening-focused UI. Activated by a persisted **Settings** toggle
(`listeningModeEnabled`, default **off**). All behavior is gated by a single
root CSS class (`bc-listening-mode`) so toggling is instant and fully
reversible — no duplicated component trees, per the UI "simplify first" rule.

## Behavior when ON

- Keep the current **waveform** exactly as-is (it already owns seeking — no
  equalizer, no separate progress/seek bar).
- **Playtime** centered in the transport meta row; **BPM** and **Key** readouts
  hidden.
- **Volume slider** moves to the far right edge of the transport controls row.
- **Tempo Adjust** and **Tap Tempo** buttons hidden.
- **Analyze Key** row hidden in Settings; key analysis forced off.
- Playlist **BPM column** hidden; **BPM sort** disabled.
- **No BPM analysis** is ever requested — only the waveform.

## Key constraint that shaped this (kept for the record)

A *true live equalizer* tapping the playing audio was the original idea but is
**infeasible**: Bandcamp's stream is cross-origin
(`bandcamp.com/stream_redirect`), so a `MediaElementAudioSourceNode` taints to
silence — an `AnalyserNode` reads zeros. See `rules/audio-rules.md` §10 / §4.8.
We only own a non-tainted Web Audio graph during SignalSmith runtime playback,
which barely engages once DJ features are off. Decision: **drop the equalizer
and keep the existing waveform** (which is already a precomputed multi-band
analysis with built-in seeking).

## Implementation by area

### 1. Setting + plumbing
- `src/content/settings/player-user-settings.ts`: add `listeningModeEnabled`
  (default `false`) to the interface, defaults, read, and write — mirroring
  `keyAnalysisEnabled`.
- `src/content/settings/settings-controller.ts` + `src/content/player/index.ts`:
  add `onToggleListeningMode`, persist, re-render.
- `PanelInput` in `src/shared/types.ts`: add `listeningModeEnabled`; thread it
  through `apply()` in `src/ui/panel.ts` and toggle the root `bc-listening-mode`
  class there.

### 2. UI (root CSS class, no DOM removal)
- `src/ui/components/settings.ts`: add a "Listening mode" toggle row; hide the
  **Analyze Key** row when listening mode is on.
- `src/ui/styles/transport.ts`: under `.bc-listening-mode`,
  - hide `.bc-transport-right-controls` (Tempo Adjust + Tap),
  - give `.bc-volume-control` `margin-left: auto` so it sits flush right
    (prev/play/next stay grouped at the left),
  - collapse `.bc-transport-meta-grid` to a single centered playtime cell
    (hide the BPM and Key `.bc-transport-meta-item`s).
- `src/ui/components/bpm-display.ts`: no structural change — cells are hidden by
  CSS.

Resulting transport row:
`[ prev / play / next ] ·········· [ volume ▸ far right ]`
with centered playtime in the meta row.

### 3. Playlist
- `src/ui/components/playlist-view.ts`: pass `listeningModeEnabled` through
  `playlist.update(...)`; hide the BPM header/cells and the bpm sort binding.
- `src/content/playlist/sorter.ts` / controller: if `sortKey === 'bpm'` when the
  mode turns on, reset to `index`.

### 4. Analysis gating (the core behavioral change)
- Add `requestWaveformOnly()` to
  `src/content/analysis/analysis-request-controller.ts` — reuse the
  source/cacheKey resolution at the top of `requestTempo` but call only
  `requestCurrentWaveform`, never `requestTempoForSource`.
- In `src/content/player/index.ts` (≈ lines 511 and 2818): when listening mode
  is on, call `requestWaveformOnly()` instead of `requestTempo()`. Playlist BPM
  decoration then stays empty naturally (the `bpmByKey` cache is never filled).
- Toggling **off** mid-track kicks a normal `requestTempo()` so BPM reappears for
  the current track.

### 5. Loose ends
- Make `tempo-up` / `tempo-down` / `tap-tempo` keyboard shortcuts inert in the
  mode (their controls are hidden).
- Preload / runtime predecode is untouched — it's playback prep, not a DJ
  feature.

## Cross-cutting
- All changes are in **shared content/UI** code → both `npm run build` (Firefox)
  and `npm run build:chrome` are required.
- Toggle applies **live** (no reload): the analysis gate only affects the next
  request, and the UI re-renders immediately.
- Docs to update on completion: `rules/ui-rules.md` (mode behavior) and the
  changelog / `rules/build-rules.md` status line.

## Verification
- Code health: `npx tsc --noEmit`, `npm run check:module-lines`,
  `git diff --check`.
- Both production builds: `npm run build`, `npm run build:chrome`.
- Manual: toggle on/off mid-track; confirm waveform + seek still work, BPM/Key
  hidden, volume flush right, Tempo Adjust/Tap gone, playlist BPM column gone,
  no BPM analysis requested (debug panel), and BPM reappears when toggled off.
