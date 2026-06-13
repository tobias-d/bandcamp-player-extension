# Bandcamp Deck v3

> This README is written for developers reading the source on GitHub. It focuses on
> architecture, the build pipeline, and the non-obvious engineering. If you just want to
> *use* the extension, the panel is self-explanatory once loaded — start at
> [Build and install](#build-and-install).

Bandcamp Deck is a cross-browser extension (Firefox MV2 + Chrome MV3 from one source tree)
that overlays Bandcamp with a persistent floating player panel. The panel follows the
currently playing track across release pages, fan/feed/recommendation pages, and Discover,
and keeps transport, waveform seeking, playlist context, real audio analysis, and
wishlist state in one place.

The parts worth reading the code for:

- **Real DSP, not DOM heuristics.** BPM, musical key, and waveform data come from decoding
  the actual audio in the background and running a custom [Essentia](https://essentia.upf.edu/)
  WebAssembly build over the PCM — see [Audio analysis](#audio-analysis-essentiajs).
- **API-first identity resolution.** Before the panel updates, the extension resolves *which*
  Bandcamp track/album/artist is playing from structured JSON endpoints rather than scraped
  page text — see [Bandcamp API usage](#bandcamp-api-usage). This is what keeps Discover and
  collection views attached to the right track and prevents wishlist writes hitting the wrong item.
- **Extension-owned runtime audio.** Tempo Adjust (BPM-based playback-rate change) plays through
  an extension-owned audio host using a patched SignalSmith stretch worklet, instead of patching
  Bandcamp's page CSP via `webRequest`.
- **One source tree, two manifests.** Firefox (MV2) and Chrome (MV3) are built as separate
  products with build-time target branching and per-target release guards.

Firefox-first during development; Chrome builds are fully supported.

## Key capabilities

- Floating player panel on release, fan, feed/recommendation, and Discover pages.
- Transport, waveform seeking, and playlist navigation in one UI.
- Background BPM analysis, optional musical-key detection, and waveform rendering for the
  currently playing audio.
- Tempo Adjust for BPM-based playback-speed changes through extension-owned runtime audio.
- Wishlist and collection integration with guarded, identity-checked album/track mutations.

Release notes live in [`CHANGELOG.md`](CHANGELOG.md) — one entry per version, added on
`npm run bump <version>`.

---

## Architecture

### Audio analysis (Essentia.js)

[Essentia.js](https://essentia.upf.edu/) is a JavaScript/WebAssembly port of the Essentia
audio-analysis library. It gives the extension real signal analysis instead of metadata guesses.

The extension fetches the current audio source, decodes it in the background, and runs Essentia
over the decoded buffer for:

- BPM detection (feeds the main tempo display)
- waveform-related preprocessing
- musical key detection (a stricter, electronic-music-oriented scoring flow that returns one
  key, two candidates, or no result when evidence is weak)

This project ships a **custom Essentia WASM build** (Essentia C++ `v2.1_beta5`, CSP-safe with
`DYNAMIC_EXECUTION=0`, a HarmonicPeaks fix, and added EDM key profiles) that is copied over the
stock `essentia.js` package at build time. Details and provenance are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the analysis-area design rules are in
[`rules/bpm-analysis-rules.md`](rules/bpm-analysis-rules.md).

### Runtime audio (SignalSmith)

[SignalSmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch)
(`signalsmith-stretch`, pinned exactly to `1.3.2`) is the time-stretching engine behind
**Tempo Adjust** — changing playback speed by BPM without the pitch artefacts of a naïve
rate change. It runs as an `AudioWorklet` inside an **extension-owned runtime audio host**
(`src/runtime-audio-host.ts`), so tempo changes never require patching Bandcamp's page CSP
via `webRequest`.

The worklet is **generated and patched at build time**
(`generate-signalsmith-worklet.js` → `vendor/signalsmith/worklet.js`) rather than loaded from
the package directly, for two reasons:

- **Firefox blob-URL worklets hang.** SignalSmith normally loads its processor from a `blob:`
  URL; in Firefox extension pages `audioWorklet.addModule()` on a blob URL never resolves. The
  build captures the generated worklet code and writes it as a static file loaded via a real
  `moz-extension://` URL.
- **Three correctness patches** are applied to the captured source, each guarded so the build
  fails loudly if upstream changes: a dead-code crash fix for `numberOfInputs: 0`, a host-only
  `clearBuffers` reset that avoids transferring discarded PCM on track change, and a multi-chunk
  feeding-loop fix that makes incremental/chunked feeding safe. The last is proven byte-correct
  by `verify-signalsmith-worklet-feeding.js` (run in every build).

This is why `signalsmith-stretch` is version-pinned. The runtime-audio design — handoff gating,
chunked feeding, and two-host ping-pong switching — is documented in
[`rules/audio-rules.md`](rules/audio-rules.md).

### Bandcamp API usage

Bandcamp Deck does substantial *identity* work before touching the panel — knowing which
Bandcamp track, album, and artist are actually playing, not just what text is on the page. It
follows an API-first rule wherever Bandcamp exposes a stable JSON source, falling back to limited
HTML parsing only where no structured equivalent exists. No external service is involved.

The four jobs the APIs do:

**1. Release metadata and tracklists.** Bandcamp's tralbum endpoints resolve artist/album
titles, release dates, track lists, track identity, durations, and stream details.
(`Tralbum` = Bandcamp's combined track-or-album record.)

- `/api/tralbum/2/info` — primary structured source
- `/api/mobile/24/tralbum_details` — secondary source for fuller track arrays, durations, and
  stream info

  > Android app logs (2026-04-24) show `/api/mobile/26/tralbum_details`, but spot checks returned
  > the same payload shape as v24, so the extension stays on v24 until a concrete difference appears.

**2. Discover and non-release playback.** Discover does not expose normal album-page data. The
extension listens to page audio through an injected bridge, then resolves the playing stream back
to Bandcamp API data — matching the stream to a track ID, building the correct playlist, keeping
BPM/waveform/key/like state on the right row, and recovering album identity from partial metadata.
While API data loads, the panel may briefly use safe bootstrap metadata from the media session or
page, then replace it once the resolver confirms the match.

**3. Wishlist and collection inventory.** To know whether an item is `liked`, `disliked`, or
`bought`, the extension reads fan/fancollection endpoints rather than trusting a single button state.

- `/api/fan/2/collection_summary`
- `/api/fancollection/1/wishlist_items`
- `/api/fancollection/1/collection_items`

Album-level and track-level state are kept separate: a bought/liked album can make every track look
available while the extension still tracks whether an individual track is separately wishlisted.

**4. Safe wishlist mutations.** A `mutation` is the write request that adds/removes a wishlist item.
It is prepared only after identity and safety checks pass (fan ID, item ID, item type, page URL,
request context, and crumb resolved first). The prepared `collect_item_cb` / `uncollect_item_cb`
POST is sent through the page-context bridge in the context Bandcamp expects; the bridge normalizes
IDs, retries once on a replacement crumb, and reports back. A successful write forces a fresh sync so
the UI reflects Bandcamp's real state instead of a long-lived optimistic guess.

See [`rules/metadata-rules.md`](rules/metadata-rules.md) and
[`rules/likes-playlist-rules.md`](rules/likes-playlist-rules.md) for the full constraints.

### Design docs

The `rules/*.md` documents capture the architectural decisions and constraints behind each major
area so sensitive changes follow the original intent instead of re-deriving it.
[`AGENTS.md`](AGENTS.md) is the entry point and links them all;
[`rules/architecture-rules.md`](rules/architecture-rules.md) has the repository layout, webpack
entry points, and a large-file navigation guide.

---

## Build and install

### Toolchain

- **Node.js `>=24`** — pinned in [`.nvmrc`](.nvmrc); run `nvm use` to match.
- **npm** — a committed `package-lock.json` makes installs reproducible.

```bash
nvm use          # selects Node 24
npm ci           # clean, lockfile-exact install (use `npm install` when changing deps)
```

> The two source-sensitive dependencies — the custom Essentia WASM and `signalsmith-stretch`
> (pinned exactly to `1.3.2`) — are patched against exact upstream source during the build, which
> is why installs are locked.

### Build pipeline

Production builds run a dependency-ordered chain. The shared `prep` step
(`prebuild:*` → `npm run prep`) runs before webpack:

1. `preflight-build-guard` — version sync across `package.json` + the three manifests, critical files present
2. `copy-custom-essentia-wasm` — copy the custom WASM build from `vendor/essentia-wasm-custom/` over the stock package
3. `patch-essentia-no-eval` — make the Essentia bundle CSP-safe
4. `generate-signalsmith-worklet` — generate + patch `vendor/signalsmith/worklet.js` from `signalsmith-stretch`
5. `verify-signalsmith-worklet-feeding` — prove the worklet feeding patch is byte-correct (also `npm run verify:worklet`)

Then webpack compiles, and `postbuild:*` runs `patch-webpack-no-eval` on the emitted runtime-audio host.
**Do not change one build step without checking the steps before and after it** — see
[`rules/build-rules.md`](rules/build-rules.md).

### Per-browser builds and releases

```bash
npm run build            # Firefox (MV2) production  -> dist/firefox/
npm run build:chrome     # Chrome  (MV3) production  -> dist/chrome/
npm run build:dev        # Firefox development build
npm run watch            # Firefox watch mode

npm run release:firefox  # rebuild + package -> releases/firefox/{.xpi,.zip}
npm run release:chrome   # rebuild + package -> releases/chrome/.zip
npm run release:all      # both, in sequence
```

`dist/` and `releases/` are gitignored (build output is not committed).

**Manifests are not interchangeable.** Firefox builds from `src/manifest.firefox.json`
(intentionally **Manifest V2** for the current Firefox path; `src/manifest.firefox.dev.json` for
dev), Chrome from `src/manifest.json` (**Manifest V3**). The release guards verify the built
manifest shape before packaging — the Firefox guard checks MV2 shape, version, the Gecko add-on ID,
and `data_collection_permissions.required: ["none"]`; the Chrome guard checks `manifest_version: 3`,
`background.service_worker`, separated `host_permissions`, and MV3 `web_accessible_resources`.
Packaging fails loudly if a build carries the other browser's manifest shape.

### Load an unpacked build

1. Open the browser's extensions page and enable developer mode.
2. Firefox: *Load Temporary Add-on* → pick any file in `dist/firefox/`.
   Chromium: *Load unpacked* → select `dist/chrome/`.

---

## Repository layout

```text
src/        Extension source (content scripts, background, UI, shared, per-target wrappers)
vendor/     Third-party shipped code: custom Essentia WASM build + generated SignalSmith worklet
tools/      Build pipeline (tools/build/*) and maintenance scripts (tools/check-bpm-offset.mjs)
rules/      Area design-rule docs — read before changing that area
website/    Marketing/demo site (deployed via .github/workflows)
dist/       Build output (gitignored): dist/firefox, dist/chrome
releases/   Packaged release artifacts (gitignored)
```

Inside `src/`:

- `src/content/` — content scripts: player, discover, metadata, playlist, likes, page integration
- `src/background/` — analysis, caching, message routing, audio decode, tempo, waveform, key
- `src/ui/` — floating panel, components, styles, debug panel, key-tuning/glass panels
- `src/shared/` — shared types and constants
- `src/targets/` — Firefox/Chrome background wrappers and the Chrome MV3 offscreen analysis host

See [`rules/architecture-rules.md`](rules/architecture-rules.md) for webpack entry points and the
detailed directory index.

---

## Verification

```bash
npx tsc --noEmit      # type-check (no test framework; strict TS is the primary correctness gate)
npm run build         # Firefox production
npm run build:chrome  # Chrome production
npm run verify:worklet # SignalSmith feeding-patch proof (also runs inside every build)
```

Manual smoke checklist:

- Release-page playback works; Discover-page panel works.
- Feed/recommendation heart actions update after inventory sync; wishlist buttons reflect synced state.
- Bandcamp download pages do **not** show the panel.
- BPM and waveform appear after analysis; key analysis appears when enabled.

A shared change should be built for **both** browsers; see the verification matrix in
[`AGENTS.md`](AGENTS.md).

---

## Notes

- Key analysis is off by default; enable it in Settings. `Alt+D` opens the debug panel.
- Firefox production no longer uses `webRequest` to patch Bandcamp page CSP — Tempo Adjust runs
  through extension-owned runtime audio instead.
- The Essentia bundle is patched automatically by the `prep` step before webpack; never edit the
  copied bundle in `node_modules` by hand.

## License

[AGPL-3.0-or-later](LICENSE). Third-party components and the custom Essentia build are documented
in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
