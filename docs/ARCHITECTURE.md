# Architecture

## Runtime Flow

1. `src/content-scripts/bandcamp-player.ts` runs on Bandcamp pages.
2. It detects the active `<audio>` element and sends `ANALYZE_TRACK` to background.
3. `src/background/messaging.ts` routes requests to `src/background/analyzer.ts`.
4. `src/background/analyzer.ts`:
   - fetches/decode audio
   - runs BPM estimation via `src/background/tempo-essentia.ts`
   - computes waveform via `src/background/waveform.ts`
   - sends `ANALYSIS_PARTIAL` updates back to content script
5. UI updates are rendered by `src/ui/results-panel.js`.

## Key Modules

- `src/background/tempo-essentia.ts`
  - Loads `essentia-wasm.umd.js` directly to avoid problematic cross-module getters in Firefox.
  - Produces BPM + confidence + beat type classification.

- `src/background/analyzer.ts`
  - Orchestrates end-to-end analysis.
  - Handles progress updates and error propagation.

- `src/content-scripts/bandcamp-player.ts`
  - Tracks playback state, transport controls, and panel rendering schedule.
  - Handles background message updates and waveform fallback requests.

## Build Targets

- Firefox:
  - Manifest source: `src/manifest.firefox.json`
  - Command: `npm run build:firefox`

- Chrome/Chromium:
  - Manifest source: `src/manifest.json`
  - Command: `npm run build:chrome`

Webpack selects the manifest via `--env target=<firefox|chrome>`.
