# Likes, Wishlist, Playlist, Preload, And Analysis Rules

## Origin Bridge And Wishlist Mutation

The Discover script cannot access Bandcamp's page-level JavaScript globals directly. An injected page-context script in `src/content/discover/origin-bridge/script/` intercepts the native audio element and posts messages back to the content script through `origin-bridge.ts`.

The same bridge currently owns page-context wishlist mutation POSTs for release, feed, recommendations, fan-root, and Discover flows after `src/content/likes/mutations.ts` has prepared and checked the request.

Do not treat the background `TOGGLE_WISHLIST_ITEM` handler as the active UI mutation path without re-checking `toggleWishlistItemPhase1StatusOnly()`.

## Likes Inventory

`src/content/likes/inventory.ts` owns `LikesStatusController`, the main facade for context updates, inventory reads, view-state resolution, mutation deltas, and debug snapshots.

Key areas:

- Sync eligibility: foreground/deep-sync decisions, cache freshness checks, rapid origin-jump pacing, and retry timing.
- `sync()` / `runSync()`: fan ID resolution, persistent/shared cache hydration, focused sync setup, endpoint results, and cache publication.
- `syncEndpoint()`: fancollection pagination, request pacing, retry/backoff handling, endpoint snapshots, and status reporting.

## Playlist And Preload Map

| Area | Files |
|------|-------|
| Playlist resolver | `src/content/playlist/resolver.ts`, `resolver-url.ts`, `resolver-tracklist.ts` |
| Playlist state | `src/content/playlist/controller.ts` |
| Track navigation | `src/content/playlist/track-selection.ts`, `track-selection-navigation.ts` |
| BPM/key sorting | `src/content/playlist/sorter.ts` |
| Analysis decoration | `src/content/playlist/analysis-decoration.ts`, `analysis-cache.ts` |
| Player preload | `src/content/player/preload-controller.ts`, `preloader.ts` |
| Discover preload | `src/content/discover/preload-controller.ts` |
| Worker concurrency | `src/shared/concurrency.ts`, `src/background/audio/worker-pool.ts` |

## Analysis Request Map

| Problem | Look in |
|---------|---------|
| BPM wrong or slow | Algorithm: `src/background/audio/tempo.ts`, correction: `tempo-beat-correction.ts`. Request flow: `src/content/analysis/tempo-request.ts` to `src/background/handlers/analysis-tempo.ts`. Concurrency: `src/shared/concurrency.ts`. |
| Key detection wrong | Algorithm: `src/background/key/` (`hpcp.ts`, `scoring.ts`, `aggregation.ts`). Request flow: `src/content/analysis/key-request.ts` to `handleAnalyzeKey` in `src/background/handlers/analysis.ts`. |
| Waveform wrong | `src/background/audio/waveform.ts`, `waveform-core.ts`, and `src/content/analysis/waveform-request.ts`. |
| Analysis request lifecycle wrong | `src/content/analysis/analysis-request-controller.ts`, `current-session-helpers.ts`, `debug-helpers.ts`. |

## Common Fix Patterns

| Problem | Look in |
|---------|---------|
| Like/wishlist state wrong | `src/content/likes/inventory.ts`, `src/content/likes/mutations.ts`, `mutation-controller.ts`, `mutation-gate.ts`, and `src/background/handlers/likes.ts`. |
| Discover wishlist mutation wrong | `src/content/discover/origin-bridge/script/` plus `src/content/likes/mutations.ts`. |
| Playlist wrong or missing tracks | `src/content/playlist/resolver.ts`, `resolver-url.ts`, and Discover `runPlaylistAttempt()` in `src/content/discover/controller.ts`. |
| Preload not working | Player `src/content/player/preload-controller.ts`; Discover `src/content/discover/preload-controller.ts`; worker pool `src/background/audio/worker-pool.ts`. |
| Add a new message type | Add a variant to `ContentMessage` in `src/shared/types.ts`, add the handler in `src/background/handlers/`, then add a case in `src/background/router.ts`. |

## Change Rules

- Do not change wishlist mutation ownership without checking the page-context bridge path first.
- If like or playlist state depends on current page state, ask for debugger Copy All or the specific relevant area before behavior changes.
- Keep retry and pacing behavior deterministic. Do not add speculative retries or hidden fallback mutation paths.
- Prefer extracting focused helpers from large orchestrators over adding more inline control flow.
