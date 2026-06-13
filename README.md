# Bandcamp Deck v3

## What this extension does

This extension turns Bandcamp into a more usable listening and crate-digging workflow.

Instead of relying only on Bandcamp's page-level player controls, it adds a persistent floating panel that follows the currently playing track and keeps playback control, metadata, analysis, playlist context, and wishlist state in one place.

The practical goal is simple: while browsing releases, fan pages, feed/recommendation pages, and Discover, you can keep listening, inspect tracks faster, and manage wishlist actions without losing context.

## Changelog

Release notes live in [`CHANGELOG.md`](CHANGELOG.md), with one entry per version. New entries are added when the version number is bumped (`npm run bump <version>`).

## Key features

- Floating player panel for Bandcamp release pages, fan pages, feed/recommendation pages, and Discover.
- Transport, waveform seeking, and playlist navigation in one UI.
- Track metadata, BPM analysis, and optional key detection for the currently playing audio.
- Tempo Adjust for BPM-based playback speed changes.
- Wishlist and collection integration, including guarded album and track wishlist actions.

## Essentia.js

[`Essentia.js`](https://essentia.upf.edu/) is a JavaScript and WebAssembly port of the Essentia audio analysis library. It gives the extension real signal-analysis tools instead of relying on rough DOM heuristics or metadata guesses.

In this project, Essentia.js is used in the background analysis pipeline for:

- BPM detection
- waveform-related audio preprocessing
- musical key detection

How we use it in practice:

The extension fetches the current audio source, decodes it in the background, and runs Essentia on the decoded buffer rather than trying to infer analysis from page markup. Tempo analysis feeds the main BPM display, while the key pipeline uses a stricter electronic-music-oriented scoring flow that can return one key, two candidates, or no result when the evidence is weak. The Essentia WASM bundle is also patched during the build so it works within extension CSP constraints.


## How we use Bandcamp's APIs

Bandcamp Deck does a lot of identity work before it updates the panel. `Identity` means the extension knows which Bandcamp track, album, and artist are actually playing, not just what text happens to be visible on the page.

The extension follows an API-first rule wherever Bandcamp exposes a stable data source. An `API` is a structured JSON endpoint: instead of guessing from page text, the extension asks Bandcamp for track IDs, album IDs, band IDs, titles, artists, track lists, stream URLs, and fan inventory.

This matters most in Discover and collection views, where the visible page is not always a normal album page. The extension uses APIs to keep the floating panel attached to the correct playing track and to avoid applying wishlist actions to the wrong album or track.

The extension uses Bandcamp APIs for four main jobs:

### 1. Release metadata and tracklists

For release pages and many non-release playback contexts, the extension uses Bandcamp's tralbum data endpoints to resolve artist names, album titles, release dates, track lists, track identity, duration, and stream details.

`Tralbum` is Bandcamp's combined word for track-or-album data. In practice, it is the structured release information the extension needs to know what is playing.

Core endpoints:

- `/api/tralbum/2/info`
- `/api/mobile/24/tralbum_details`

`/api/tralbum/2/info` is the primary structured source. `/api/mobile/24/tralbum_details`
is used as a secondary structured source when the extension needs fuller track arrays,
durations, stream information, or release details. Android app logs from April 24, 2026
also show `/api/mobile/26/tralbum_details`, but spot checks returned the same payload
shape as the existing `/api/mobile/24/tralbum_details` path, so the extension keeps the
current v24 endpoint until a concrete payload difference is found.

### 2. Discover and non-release playback

Discover does not expose the same page-level data as a normal album page. Bandcamp Deck listens to the page audio through an injected bridge, then resolves the playing stream back to Bandcamp API data.

That flow lets the extension:
- match the audio stream to a Bandcamp track ID
- build the correct playlist around the current track
- keep BPM, waveform, key, and like state attached to the right playlist row
- recover album identity even when the visible page only gives partial metadata

When API data is still loading, the panel may briefly use safe bootstrap metadata from the media session or page. It replaces that with structured API metadata as soon as the resolver confirms the match.

### 3. Wishlist and collection inventory

To determine whether an item is `liked`, `disliked`, or `bought`, the extension reads Bandcamp's fan and fancollection endpoints instead of trusting a single button state in the page UI.

Core endpoints:

- `/api/fan/2/collection_summary`
- `/api/fancollection/1/wishlist_items`
- `/api/fancollection/1/collection_items`

These endpoints let the extension resolve the logged-in fan context, fetch wishlist and collection inventory, and merge both into one stable UI state model.

The important user-facing result is that album-level and track-level state are separated. For example, a bought or liked album can make every track look available in the panel, while the extension still remembers whether an individual track is separately in the wishlist.

### 4. Safe wishlist mutations

When you click a heart, the extension prepares a mutation request only after identity and safety checks pass. A `mutation` is the write request that asks Bandcamp to add or remove a wishlist item. The preflight step resolves the fan ID, item ID, item type, page URL, request context, and crumb before the POST is attempted.

The current UI path sends that prepared request through the page-context bridge so Bandcamp receives the authenticated collect or uncollect POST in the context it expects. The bridge normalizes IDs, chooses the correct `collect_item_cb` or `uncollect_item_cb` endpoint, retries once when Bandcamp returns a replacement crumb, and reports the result back to the content script. After a successful write, the extension forces a fresh sync so the UI reflects Bandcamp's actual state instead of a long-lived optimistic guess.

This mutation flow is used for adding and removing wishlist items while keeping album and track state consistent after writes, including feed, recommendations, Discover, fan pages, and release pages.

The extension prefers Bandcamp JSON endpoints for truth and synchronization, and only falls back to limited HTML parsing where Bandcamp does not expose an equivalent structured source. It does not use a separate external service for metadata or inventory sync.


## Build and install

### Prerequisites

- `Node.js`
- `npm`

### Install dependencies

```bash
npm install
```

### Build for Firefox

```bash
npm run build
```

This writes the unpacked Firefox extension to `dist/firefox/`.

### Package a Firefox release

```bash
npm run release:firefox
```

This rebuilds Firefox production and writes final release artifacts to `releases/firefox/`:
- `bandcamp-deck-firefox-<version>.xpi`
- `bandcamp-deck-firefox-<version>.zip`

The Firefox release package is built from `src/manifest.firefox.json` and is intentionally Manifest V2 for the current Firefox release path. The release guard verifies the Firefox manifest shape, the package version, the Gecko add-on ID required for signing, and the explicit `data_collection_permissions.required: ["none"]` declaration before packaging.

### Build for Chrome

```bash
npm run build:chrome
```

This writes the unpacked Chrome extension to `dist/chrome/`, using the Chrome-oriented manifest.

### Package a Chrome release

```bash
npm run release:chrome
```

This rebuilds Chrome production and writes `bandcamp-deck-chrome-<version>.zip` to `releases/chrome/`.

The Chrome release package is built from `src/manifest.json` and must be Manifest V3. The release guard verifies the built `dist/chrome/manifest.json` before zipping, including `manifest_version: 3`, `background.service_worker`, separated `host_permissions`, and MV3 `web_accessible_resources`.

### Package both browsers

```bash
npm run release:all
```

This runs the Firefox and Chrome release packaging commands in sequence.

Release packaging fails loudly when a browser build contains the other browser's manifest shape. In plain terms: Chrome cannot package a Firefox/MV2 manifest, and Firefox cannot package the Chrome/MV3 service-worker manifest by accident.

### Watch mode

```bash
npm run watch
```

### Load the extension

1. Open your browser's extensions page.
2. Enable developer mode.
3. Choose "Load temporary add-on" in Firefox or "Load unpacked" in Chromium-based browsers.
4. Select the browser-specific build directory:
   - Firefox: `dist/firefox/`
   - Chrome: `dist/chrome/`

## How to use

1. Open a Bandcamp page with playable audio.
2. Start playback from the page or from the floating panel.
3. Use the panel for transport, playlist navigation, waveform seeking, and BPM reading.
4. Open Settings to toggle `Preload tracks` or `Analyze Key`.
5. Use the heart controls to add or remove items from your wishlist.

Advanced shortcuts:
- `Alt+D`: open the debug panel

## Architecture and design docs

The repo includes a set of `*-rules.md` documents under `rules/` that capture the architectural decisions and constraints behind each major area, so changes in sensitive parts follow the original design intent instead of re-deriving it. `AGENTS.md` links to them as the entry point.

## Project structure

Important folders:

- `src/content`: content scripts for player, discover, metadata, playlist, likes, and page integration
- `src/background`: analysis, caching, routing, audio decoding, tempo, waveform, and key analysis
- `src/ui`: floating panel UI, components, styling, debug panel, key tuning panel
- `src/shared`: shared types and constants

## Verification

Useful local checks:

```bash
npx tsc --noEmit
npm run build
npm run build:chrome
```

Manual smoke test checklist:
- Release page playback works.
- Discover page panel works.
- Feed or recommendation heart actions update after inventory sync.
- Bandcamp download pages do not show the floating panel.
- BPM and waveform appear after analysis.
- Wishlist buttons reflect synced state.
- Key analysis appears when enabled.

## Notes

- Key analysis is off by default and can be enabled in Settings.
- The build patches the Essentia.js bundle before compiling. That happens automatically through the `prebuild:*` scripts.
- Firefox production no longer uses `webRequest` to patch Bandcamp page CSP; Tempo Adjust runs through extension-owned runtime audio instead.
- The repo is Firefox-first during development, but Chrome builds are supported.
