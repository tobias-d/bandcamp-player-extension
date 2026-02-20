# Architecture

## Runtime Flow

1. `src/content-scripts/bandcamp-player.ts` observes Bandcamp playback state and drives panel updates.
2. It requests analysis via `ANALYZE_TRACK`/`GETWAVEFORM` to background.
3. `src/background/messaging.ts` routes requests to analyzer, waveform, storage, and playlist-fetch handlers.
4. `src/background/analyzer.ts` fetches/decodes audio, runs Essentia BPM detection, and emits partial/final results.
5. `src/ui/results-panel.ts` renders the floating player, waveform, BPM section, transport controls, and playlist UI.

## Key Modules

- `src/content-scripts/playlist.ts`: playlist resolution, sorting, selection, and track-jump behavior
- `src/content-scripts/metadata-extractor.ts`: now-playing metadata extraction across Bandcamp page contexts
- `src/background/waveform.ts`: multi-band waveform generation + caching
- `src/background/storage.ts`: persisted preferences and cached analysis values

## Build Targets

- Firefox: `src/manifest.firefox.json` (`npm run build:firefox`)
- Chromium: `src/manifest.json` (`npm run build:chrome`)
