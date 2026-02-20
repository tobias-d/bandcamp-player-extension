# Bandcamp Player Extension

A floating Bandcamp player with reliable BPM analysis (Essentia.js), waveform visualization, and playlist-aware playback controls.

![Screenshot](image.png)

## Latest Change (v2.5)

- Added a robust Playlist workflow across album, track, collection, feed, and recommendation contexts.
- Added an Information button (`i`) with quick links for feedback and support.
- Improved playlist/playback syncing and stability when switching between page-native and external playlist sources.

## Main Features

- Floating player overlay on Bandcamp pages
- BPM detection using `essentia.js` (WASM)
- 3-band waveform visualization (low / mid / high)
- Playlist UI with track list, BPM, duration, sorting, and track jump
- Previous/next/play transport controls and media key support
- Background analysis cache reused across pages

## Browser Targets

- Firefox (MV2): `src/manifest.firefox.json`
- Chromium (MV3): `src/manifest.json`

## Build

```bash
npm install
npm run build:firefox
npm run build:chrome
npm run build:dev
```

## Firefox Local Load

1. Build: `npm run build:firefox`
2. Open: `about:debugging#/runtime/this-firefox`
3. Load temporary add-on: `dist/manifest.json`

## Project Structure

- `src/content-scripts/bandcamp-player.ts`: content orchestration and player state sync
- `src/content-scripts/playlist.ts`: playlist resolution, ordering, and track switching
- `src/background/messaging.ts`: message routing between content and background
- `src/background/analyzer.ts`: BPM + waveform analysis orchestration
- `src/background/tempo-essentia.ts`: Essentia-based tempo estimation
- `src/background/waveform.ts`: waveform generation/cache
- `src/ui/results-panel.ts`: floating player/panel UI rendering

## License

Project source is MIT-licensed (see `LICENSE`).

Third-party note: this project uses `essentia.js` (`AGPL-3.0`). Distribution must comply with AGPL obligations for that dependency.

See:
- `docs/THIRD_PARTY_NOTICES.md`
- `node_modules/essentia.js/LICENSE`
