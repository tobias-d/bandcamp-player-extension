# Bandcamp Player Extension

Floating Bandcamp player extension with BPM detection (Essentia.js), waveform visualization, and transport controls.

![Screenshot](image.png)

## Latest Change (v2.2)

- Replaced static BPM confidence with Essentia-derived confidence and switched UI to a compact confidence light
- Decoupled BPM from confidence timing so BPM appears first and confidence updates later
- Added cancellation and stale-update guards so track switches prioritize current playback analysis
- Added persisted analysis caching in extension storage for faster repeat lookups across sessions
- Improved analysis pipeline performance by removing redundant preprocessing and reusing decoded/preprocessed data
- Added album/compilation speculative preload queue with user-triggered track analysis always taking priority
- Moved panel size/position persistence to extension storage so settings survive restarts and work across Bandcamp subdomains

## What It Does

- Floating draggable player UI on Bandcamp pages
- BPM analysis using Essentia WASM in the background script
- 3-band waveform generation (low / mid / high)
- Play/pause, seek, previous/next controls
- Manual BPM tapper in the UI

## What Is Essentia?

Essentia is an open-source audio analysis and music information retrieval library.  
This extension uses `essentia.js` (the WebAssembly/JavaScript port) to run BPM detection in the background.

- Project site: https://mtg.github.io/essentia.js/
- GitHub: https://github.com/MTG/essentia.js

## Browser Targets

This project ships with two manifests:

- `src/manifest.firefox.json` (MV2) for Firefox Developer Edition temporary add-ons
- `src/manifest.json` (MV3) for Chromium-based browsers

Webpack selects the manifest by build target.

## Build Commands

1. Install dependencies:
```bash
npm install
```

2. Build for Firefox (default):
```bash
npm run build
# same as: npm run build:firefox
```

3. Build for Chrome/Chromium:
```bash
npm run build:chrome
```

4. Development build:
```bash
npm run build:dev
```

5. Build upload package for AMO:
```bash
npm run package:firefox
```

## Load In Firefox Developer Edition

1. Build:
```bash
npm run build
```

2. Open:
`about:debugging#/runtime/this-firefox`

3. Click `Load Temporary Add-on...`

4. Select:
`dist/manifest.json`

## Project Structure

- `src/content-scripts/bandcamp-player.ts`: content script orchestration + panel callbacks
- `src/background/index.ts`: background entrypoint and startup
- `src/background/messaging.ts`: request routing between content/background
- `src/background/analyzer.ts`: analysis pipeline orchestration
- `src/background/tempo-essentia.ts`: Essentia WASM tempo estimator
- `src/background/waveform.ts`: waveform computation/cache
- `src/ui/results-panel.ts`: floating panel UI
- `webpack.config.js`: target-aware bundling + manifest selection

## Troubleshooting

- `background.service_worker is currently disabled. Add background.scripts.`
  - Use Firefox build target (`npm run build` / `npm run build:firefox`).

- `call to Function() blocked by CSP`
  - `essentia-wasm.umd.js` is patched at build time by `scripts/patch-essentia-no-eval.js` to remove `new Function(...)`.
  - Ensure build ran through npm scripts (they run the patch automatically).
  - Rebuild and reload temporary add-on.

- `Cross-Origin Request Blocked ... bcbits.com`
  - Firefox manifest must include `*://*.bcbits.com/*` permission (already configured).
  - Remove and re-add the temporary add-on after manifest changes.

## License

This repository's original source is MIT-licensed (see `LICENSE`), and it also includes third-party dependencies with their own licenses.

Important: this project currently uses `essentia.js` (`AGPL-3.0`). If you distribute the built extension, you must comply with AGPL-3.0 obligations for that dependency and any combined distribution.

See:
- `docs/THIRD_PARTY_NOTICES.md`
- `node_modules/essentia.js/LICENSE`
