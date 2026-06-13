# Architecture And Conventions Rules

## Architecture Rules

- Prefer one clear runtime path over layered fallback paths.
- Avoid hidden branching that makes data flow or runtime ownership harder to reason about.
- If complexity grows inside a large orchestrator, prefer extracting a focused helper or module instead of adding more inline control flow.
- Keep modules easy to scan: explicit names, narrow helpers, small state transitions, and comments that explain why a tricky branch exists.

## Repository Layout

```text
src/        Extension source (see Directory Index below).
vendor/     Third-party code we ship: custom Essentia WASM build and the
            generated SignalSmith worklet. "Theirs", not ours.
tools/      Build and maintenance scripts. tools/build/ runs in the npm build
            chain; tools/check-bpm-offset.mjs is a standalone validation tool.
rules/      Area rule docs (this folder) — read before changing that area.
dist/       Build output (gitignored). dist/firefox and dist/chrome.
releases/   Local packaged release archives (gitignored, not in version control).
website/    Marketing/demo site, deployed via .github/workflows.
```

## Webpack Entry Points

- `targets/firefox/background/index.ts` — Firefox MV2 background script wrapper.
- `targets/chrome/background/index.ts` — Chrome MV3 service worker wrapper.
- `background/audio/analysis-worker.ts` — Essentia WASM Web Worker.
- `content/player/index.ts` — player script for album, track, collection, and fan pages.
- `content/discover/index.ts` — Discover script for `bandcamp.com/discover`.
- `runtime-audio-host.ts` — extension runtime audio host used by Tempo Adjust and SignalSmith playback.
- Chrome only: `targets/chrome/offscreen/analysis-host.ts` — MV3 offscreen analysis host.

Message flow: content scripts call `sendMessage<T>(msg)` from `src/utils/messaging.ts`; `src/background/router.ts` dispatches to background handlers and returns the response.

## Directory Index

```text
src/background/
  index.ts                      Entry: registers router, inits worker pool
  router.ts                     Message dispatcher
  cache.ts                      In-memory analysis result cache
  welcome-marker.ts             Tracks whether welcome screen has been shown
  key-essentia.ts               Essentia key analysis integration
  audio/                        Analysis worker, decoder, tempo, key, waveform helpers
  handlers/                     Background message handlers
  handlers/tralbum/             Tralbum metadata fetcher
  key/                          Musical key detection HPCP pipeline

src/content/
  page-context.ts               Detect page type
  playback-handoff.ts           Content-side playback notification
  player/                       Main player page runtime
  discover/                     Discover runtime and origin bridge
  metadata/                     Track and album metadata extraction
  likes/                        Likes, wishlist, mutation, inventory state
  playlist/                     Playlist resolution, sorting, selection, decoration
  analysis/                     Analysis request lifecycle
  debug/                        Debug panel state and body assembly
  settings/                     User settings

src/ui/
  panel.ts                      Main injected panel
  styles.ts                     Global panel styles entry
  components/                   UI components
  debug-panel/                  Debug panel UI
  key-tuning/                   Key tuning UI
  styles/                       CSS-in-JS style modules

src/shared/
  types.ts                      Shared types and ContentMessage union
  constants.ts                  Default state objects, debug keys
  concurrency.ts                Worker/preload concurrency derivation

src/utils/
  messaging.ts                  Content-to-background RPC helper
  browser-api.ts                chrome.* / browser.* abstraction
  debug.ts                      createLogger('TAG')
  dom.ts                        DOM query/build helpers
  cache.ts                      Generic TTL cache
  html-parser.ts                HTML parsing utilities
  asset-url.ts                  Extension asset URL resolution
```

## Large File Guide

Prefer `rg -n "functionName|const name"` over hard-coding line numbers.

### `src/content/player/index.ts`

Single `init()` closure that orchestrates the entire player.

| Anchor | Contents |
|--------|----------|
| Header | Imports and top-level constants. |
| `init()` | Main closure start; page context, state, settings, and controller setup. |
| Early `init()` helpers | Readiness gates for metadata, playlist, analysis, preload, and runtime audio. |
| Like identity region | Album/track like identity locking, trust checks, debug events, and view-state resets. |
| Analysis/render region | BPM/key/waveform callbacks, playlist decoration, debug body, and render scheduling. |
| Runtime audio region | Tempo Adjust preparation, SignalSmith runtime predecode, playback handoff, and debug state. |
| `source-transition.ts` | Pure helper for classifying source switches before side effects are applied. |
| `applySourceChange()` | Core source switch handler. |
| `syncBridgeAudioState()` | Bridge polling, native audio state sync, runtime ownership checks, timers, cleanup, and deactivation. |

### `src/content/discover/controller.ts`

Single `initDiscoverController()` closure. Pure helpers are extracted to `controller-helpers.ts`.

| Anchor | Contents |
|--------|----------|
| Header | Imports, constants, and helper imports from `controller-helpers.ts`. |
| `initDiscoverController()` | Main closure start; Discover bridge setup, state, settings, likes controller, and trace buffers. |
| Album/like identity region | Release identity caching, album/track like identity resolution, and focused like sync inputs. |
| Analysis readiness region | BPM/key/waveform readiness gates, current-track settle checks, and analysis kickoff. |
| Runtime/preload/navigation region | Discover preload queue, runtime audio preparation, playlist selection, relative jumps, and auto-advance. |
| Panel/debug region | Panel input assembly, debug body, debug panel, and render loop. |
| `runPlaylistAttempt()` | Metadata-to-playlist pipeline, API/cache probing, resolver tracing, poll scheduling, and playlist loading state. |
| `syncFromDiscover()` | Track-change detection, ended-event handling, origin/runtime ownership reset, metadata carryover, and run startup. |

### `src/content/likes/inventory.ts`

| Anchor | Contents |
|--------|----------|
| Header | Imports, constants, `SyncInput`, and module-level helper functions. |
| `LikesStatusController` | Public facade for context updates, inventory reads, view-state resolution, mutation deltas, and debug snapshots. |
| Sync eligibility region | Foreground/deep-sync decisions, cache freshness checks, rapid origin-jump pacing, and retry timing. |
| `sync()` / `runSync()` | Main sync orchestration. |
| `syncEndpoint()` | Fancollection pagination, request pacing, retry/backoff handling, endpoint snapshots, and status reporting. |
| Exported helpers | Page-context sync input builders and sync-start logging helpers. |

## Conventions

- Path alias: `@/` maps to `src/`. Always use `@/` for cross-directory imports; relative paths only within the same directory.
- Types: shared types live in `src/shared/types.ts`. Import as `import type { X } from '@/shared/types'`. Module-local types may live alongside their module.
- Logging: use `const logger = createLogger('TAG')` from `@/utils/debug`. Enable in browser with `localStorage.setItem('__BC_DEBUG__', '1')`.
- Architecture pattern: no classes except `LikesStatusController` and `PlayerState`. Other modules use closure-returning factory functions or plain named exports.
- No test framework is configured. TypeScript strict mode through webpack is the primary correctness check.
- Browser-targeted code should prefer the build-time `__BUILD_TARGET__` constant, typed in `src/types/build-globals.d.ts` and injected by webpack `DefinePlugin`.
- Worker count and preload concurrency are derived at runtime from `navigator.hardwareConcurrency` via `src/shared/concurrency.ts`. Do not hardcode them.
- Do not introduce non-deterministic behavior, hidden retries, random timing guesses, or fallback-heavy control flow unless there is a clearly documented product need.
- Solve the actual problem with the smallest stable design. Prefer a focused refactor, helper extraction, or tighter state model over large new blocks.
