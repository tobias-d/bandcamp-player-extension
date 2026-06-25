# UI Panel Rules

**Audience.** Two readers at once: a developer who wants to *understand and rebuild* the
injected panel, and an LLM agent changing it. The file therefore explains *why* the panel
works the way it does, not only where the files are. Read it before touching the injected UI.

**Scope.** The custom panel injected into the Bandcamp page DOM — how it lives inside the
page, its components, and its styling constraints. This is **not** the debug panel
(`rules/debugger-rules.md`) and **not** an extension popup.

## Simplify First (applies to every prompt)

The injected UI is large and has accreted complexity over time. Every change MUST first ask
how the UI can be made *simpler* — fewer components, less local state, smaller and less
duplicated styles — before adding anything new. Prefer deleting or merging over extending.

- A prompt that only adds surface area without considering removal has not met this rule.
- If a change makes the UI bigger, the final response MUST say why simplification was not
  possible.
- Keep component and style files small; when one grows hard to follow, propose a focused
  refactor as part of the task rather than layering on top of it.

## Why It Is Injected, Not A Popup

- The panel is injected into the **live Bandcamp page DOM** by `src/ui/panel.ts`. It runs
  inside the page's own document, style cascade, and lifecycle — not in an isolated extension
  popup window.
- That placement is the source of the **injected-page constraints**: the panel shares
  Bandcamp's CSS cascade and DOM, so host-page styles can reach the panel and the panel must
  coexist with a page it does not own. Treat the host page as a hostile styling environment.

## Structure

- Injection / entry point: `src/ui/panel.ts`.
- Component files: `src/ui/components/`.
- Styles: `src/ui/styles.ts` and `src/ui/styles/` (one file per surface, e.g.
  `panel-shell.ts`, `transport.ts`, `playlist.ts`, `glass.ts`).
- The liquid-glass surface and the Appearance panel live under `src/ui/glass/`.
- Keep changes consistent with the existing components and the injected-page constraints
  above; follow the established component and style patterns before inventing a new one.

The panel also hosts several attached sub-panels opened by keyboard or from the menus:
Appearance (Alt+G, see below), key tuning (Alt+K). The debug panel (Alt+D) is a separate
surface — see `rules/debugger-rules.md`.

## Glass Surface And Appearance Panel

The panel body is a tunable "liquid glass" surface. Its parameters live in
`src/ui/glass/glass-settings.ts` as `GlassSettings`, are persisted to `localStorage` under
`__BC_GLASS__`, and are applied by the controller in `src/ui/glass/glass-effect.ts`. Settings
load and apply on creation, so a tuned look survives reloads even if the panel is never
opened.

The **Appearance panel** (`src/ui/glass/appearance-panel.ts`) is the live-tuning surface,
opened with **Alt+G** or via Settings → Appearance → Edit. It deliberately exposes only two
controls plus reset:

- **Frost** — a single 0..1 slider that drives tint and blur *together* (`withGlassPosition`
  couples them; tint *is* the position). The other glass parameters (refraction, bezel, lens,
  specular) keep their defaults and are not user-exposed.
- **Background** — a `‹ name ›` stepper that cycles the styles in `BACKGROUND_STYLES`.

Keep this surface minimal: do not expose a control per glass parameter. If a change adds a
control, the response MUST justify why the existing two-control model could not absorb it.

### Background styles (extensible)

Background styles are an index (`bgStyle`) into `BACKGROUND_STYLES` in `glass-settings.ts`.
Index 0 is always `None`; current styles are `Camouflage`, `Prism`, and `Marble`. Each style
is a single pointer-transparent, `aria-hidden` layer below the content, shown only when its
style is selected — `glass-effect.ts` sets one mutually-exclusive `--glass-<style>` CSS
variable (`0` = off) in `apply()` based on `bgStyle`. (Camouflage's amount/blur/tone are fixed
constants, not user-tunable.)

To add a new background pattern:

1. Append the display name to `BACKGROUND_STYLES` and add a `BG_STYLE_<NAME>` index constant
   in `src/ui/glass/glass-settings.ts`.
2. In `src/ui/glass/glass-effect.ts`, build the layer element in setup (pointer-transparent,
   `aria-hidden`, below the content) and, in `apply()`, gate its `--glass-<name>` variable on
   `settings.bgStyle === BG_STYLE_<NAME>`.
3. Add the layer's CSS and its `--glass-<name>` visibility gate to `GLASS_CSS` in
   `src/ui/styles/glass.ts`.

The Appearance stepper needs no change — it cycles `BACKGROUND_STYLES` automatically, so new
entries appear by themselves. Reuse the existing gated-layer pattern rather than inventing a
new toggling mechanism; keep prefer-CSS, no per-resize repaint behavior (the existing layers
are seam-free and expand without restitching).

## Listening Mode

A persisted Settings toggle (`listeningModeEnabled`, default off) that disables every DJ-oriented
feature for a clean listening UI. It is gated by a single root CSS class, `bc-listening-mode`,
toggled on `.bc-panel-root` in `panel.ts apply()`, so the whole mode is instant and reversible —
**prefer extending that class with CSS over deleting/rebuilding DOM**.

What it does when on:
- Keeps the waveform unchanged (it already owns seeking — there is no equalizer/extra seek bar; a
  live spectrum tap is impossible because Bandcamp's cross-origin stream taints a
  `MediaElementAudioSourceNode` to silence — see `rules/audio-rules.md` §10).
- Transport meta row collapses to the centered playtime; the BPM and Key readouts are hidden
  (`src/ui/styles/transport.ts`, `.bc-listening-mode`).
- Tempo Adjust + Tap buttons are hidden and the volume control is pinned to the right edge of the
  controls pill; their keyboard shortcuts are made inert in `panel.ts onDocumentKeyDown`.
- Settings **deactivates** the Analyze Key row (dimmed + non-interactive via `bc-settings-row-disabled`, `settings.ts update()`); key analysis is forced off.
- Enabling it opens an opt-in explainer dialog (`createConfirmDialog`, same style as Key analysis); only on confirm is it persisted. It applies live — **no page reload**.
- Playlist hides the BPM column (`.bc-bpm-disabled` in `src/ui/styles/playlist.ts`) and the key
  columns, and a `bpm` sort is reset to `index` on entry (`panel-handlers.ts` /
  `discover/controller.ts`).
- **No BPM analysis runs:** the player/Discover request the waveform only via
  `analysisReqCtrl.requestWaveformOnly()` instead of `requestTempo()` (gated in
  `player/index.ts` and `discover/controller.ts`). The setting is global, so the mode applies to
  both the player and Discover.

## Fix Map

| Problem | Look in |
|---------|---------|
| UI panel issue | `src/ui/panel.ts`, `src/ui/components/`, `src/ui/styles/`. |
| Glass / Appearance / background style issue | `src/ui/glass/` (`glass-settings.ts`, `glass-effect.ts`, `appearance-panel.ts`) and `src/ui/styles/glass.ts`. |
| Listening mode (DJ features disabled) | Toggle/setting: `player-user-settings.ts`, `settings-controller.ts`, `settings.ts`. Gating: `panel.ts` (`bc-listening-mode` class), `transport.ts` + `playlist.ts` styles, `analysis-request-controller.ts` (`requestWaveformOnly`). |
