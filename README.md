# Bandcamp Player Extension

Bandcamp Player Extension is a floating player add-on for Bandcamp. A key focus of this add-on is accurate tempo (BPM) detection for DJs, producers, and music diggers.  
This plugin was developed with ChatGPT 5.3 Codex.

It adds a lightweight player overlay with transport controls and real-time analysis tools directly on Bandcamp pages. The main differentiator versus other Bandcamp plugins is its analysis engine: BPM is detected with Essentia (WASM), not simple heuristics, for more reliable tempo readings.

The add-on currently supports Firefox and Chromium builds, and publication on the Firefox Add-ons Store is in the pipeline.

## Main Features

- Accurate BPM detection optimized for electronic music workflows
- 3-band waveform visualization (low / mid / high)
- Background analysis caching for faster repeat lookups
- Album-track preload analysis on `/album/` pages (analyzes upcoming tracks in the background)
- Play/pause, seek, and previous/next transport controls
- Manual tap tempo as a quick secondary BPM reference

## Additional Info About Essentia

Essentia is an open-source audio analysis and music information retrieval library developed for high-quality music signal analysis.

This extension uses `essentia.js` (the WebAssembly/JavaScript port of Essentia) in the background script to estimate tempo from decoded audio data. That analysis-first approach is what sets this add-on apart from typical Bandcamp player extensions.

- Project site: https://mtg.github.io/essentia.js/
- GitHub: https://github.com/MTG/essentia.js

![Screenshot](image.png)

## Latest Change (v2.3)

- Added analysis caching so BPM/waveform results are reused across track revisits and sessions
- Added album-track background preload analysis that analyzes upcoming tracks while the current track is playing
- Added smooth waveform blend-in behavior so waveform visuals appear more naturally as analysis data becomes available

## Previous Change (v2.2)

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

## License

This repository's original source is MIT-licensed (see `LICENSE`), and it also includes third-party dependencies with their own licenses.

Important: this project currently uses `essentia.js` (`AGPL-3.0`). If you distribute the built extension, you must comply with AGPL-3.0 obligations for that dependency and any combined distribution.

See:
- `docs/THIRD_PARTY_NOTICES.md`
- `node_modules/essentia.js/LICENSE`
