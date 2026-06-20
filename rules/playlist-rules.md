# Playlist, Preload & Analysis-Routing Rules

**Scope:** how playlists are resolved/sorted/selected, how player and Discover preload work, and
how analysis (BPM/key/waveform) requests are routed content→background. This is a **map**
(where-to-look + guardrails), not a rebuild narrative.

> For the deep references: like/wishlist/collection **inventory + mutation** lives in
> `rules/wishlist-and-collection.md`; **BPM/tempo accuracy** in `rules/bpm-analysis-rules.md`;
> **runtime audio playback** in `rules/audio-rules.md`; **metadata/identity** in
> `rules/metadata-rules.md`.

## Playlist & Preload Map

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
| BPM wrong or slow | Algorithm: `src/background/audio/tempo.ts`, correction: `tempo-beat-correction.ts`. Request flow: `src/content/analysis/tempo-request.ts` to `src/background/handlers/analysis-tempo.ts`. Concurrency: `src/shared/concurrency.ts`. (Accuracy decisions: `rules/bpm-analysis-rules.md`.) |
| Key detection wrong | Algorithm: `src/background/key/` (`hpcp.ts`, `scoring.ts`, `aggregation.ts`). Request flow: `src/content/analysis/key-request.ts` to `handleAnalyzeKey` in `src/background/handlers/analysis.ts`. |
| Waveform wrong | `src/background/audio/waveform.ts`, `waveform-core.ts`, and `src/content/analysis/waveform-request.ts`. |
| Analysis request lifecycle wrong | `src/content/analysis/analysis-request-controller.ts`, `current-session-helpers.ts`, `debug-helpers.ts`. |

## Fix Map

| Problem | Look in |
|---------|---------|
| Playlist wrong or missing tracks | `src/content/playlist/resolver.ts`, `resolver-url.ts`, and Discover `runPlaylistAttempt()` in `src/content/discover/controller.ts`. |
| Preload not working | Player `src/content/player/preload-controller.ts`; Discover `src/content/discover/preload-controller.ts`; worker pool `src/background/audio/worker-pool.ts`. |
| Like/wishlist/collection state wrong | See `rules/wishlist-and-collection.md` (inventory sync, like-state, mutation, identity). |
| Add a new message type | Add a variant to `ContentMessage` in `src/shared/types.ts`, add the handler in `src/background/handlers/`, then add a case in `src/background/router.ts`. |

## Change Rules

- Keep retry and pacing behavior deterministic. Do not add speculative retries or hidden fallback
  paths (playlist resolution, preload scheduling, or analysis routing).
- Prefer extracting focused helpers from large orchestrators (resolver, preload controllers,
  `runPlaylistAttempt()`) over adding more inline control flow.
- One stage owns one job: BPM, key, and waveform are separate request pipelines with separate
  caches/status; do not let enabling one restart a settled result from another (see
  `rules/bpm-analysis-rules.md`).
- If playlist state depends on current page state, ask for debugger Copy All or the relevant area
  before behavior changes.

## Verification

- Code health: `npx tsc --noEmit`, `npm run check:module-lines`, `git diff --check`.
- Shared content path → run both builds: `npm run build` (Firefox), `npm run build:chrome`.
- See `rules/build-rules.md` for the full verification matrix.
