# Project Code Review — Progress & Handoff

Structured review of the entire Bandcamp Deck extension, split into 7 areas. This
file is a temp handoff so the work can resume in a fresh thread. (Safe to delete
or gitignore.)

## Method (how each area is run)

1. Read the relevant `rules/*.md` doc first (behavioral contract for that area).
2. Map the file surface (`find … | xargs wc -l`), split large areas into sub-passes.
3. Per sub-pass: launch **parallel finder agents** — one correctness (angles A/B/C),
   one cleanup (angles D/E/F) — each reading the target files fully, returning
   `{ file, line, summary, failure_scenario }` candidates.
4. **Verify the high-signal candidates myself** by reading the actual code (don't
   trust finders blindly — they over-surface and occasionally mis-call; e.g. a
   "dead" function that was actually live).
5. Triage into: fix-now (verified, low-risk) / discuss / defer (large refactor).
6. Fix the safe set → `npm run build` (Firefox) **and** `npm run build:chrome` →
   user pastes a debugger "Copy All" dump for a live sanity check → commit.

### Hard constraints (from memory / project rules)
- **Never auto-commit** (only when the user says "commit"); **never push** (a hook
  hard-blocks agent push).
- **Always `npm run build` after changes** (Firefox loads from `dist/`); also
  `npm run build:chrome`. Both must compile clean before declaring done.
- No hot fixes / speculative guards / hidden fallback paths; understand root cause.
- Keep retry/pacing **deterministic**.
- Don't change wishlist **mutation ownership** without checking the page-context
  bridge path first (the bridge `runLikesMutation` is the sole active POST owner).
- `check:module-lines` script referenced in rules is NOT in package.json — ignore.

## Status

- ✅ Area 1 — Runtime Audio Pipeline — commit `e936fd8`
- ✅ Area 2 — BPM & Key Analysis — commit `d477e1d`
- ✅ Area 3 — Metadata, Tralbum & Identity — `4b2a3b8`, `ba30849`, `076b671`, `eb8244c` (+3d verify-only)
- ✅ Area 4 — Likes, Wishlist & Playlist — `b4cff32`, `b55d002`, `328e68e`, `5c91741` (+4e review-only)
- ✅ Area 5 — Discover Controller & Origin Bridge — 5a `37c0b96`, 5b `24ea64e`, 5c `5d07ae8`+`984ccc1`, 5d `48cc185`
- ✅ Area 6 — UI, Glass & Debug Panel — 6d `c2e48c0`, 6b-1 `15bf2d1`, 6b-2 `d9e8605`, 6c `c928626`, 6e `38e42ba`, 6a `7a26d52`+`8d16fd2`
- ✅ Area 7 — Background Infrastructure & Shared — 7a `42bf4d6` (dead `router.ts`); 7d `4f77803` (dead exports); 7b `f8977fc` (storage dedup); 7c `db5ecee` (worker-pool dispatch dedup, verified live)

## What each committed area fixed (brief)

- **A1** `e936fd8`: origin-wins on different-track; stale-host stop; handover restoreOrigin in finally; tempo allowPaused; coalescing gate via runtimePlaylistStartSource; removed firstOriginAvailable field; loadTrack pre-assignment removed.
- **A2** `d477e1d`: bind key analysis to settled BPM (Firefox bg + Chrome offscreen); classifyBeatType on rounded bpm; scheduleTempoRefinement threads enableKeyAnalysis; grid-refine uses 70/170 range; removed dead enableKeyAnalysis option + buildRefiningTempoStatus; deduped median; documented low-ambiguous/mid-underread overlap.
- **A3a** `4b2a3b8` (background tralbum): bound cache enrichment to once-per-dimension (durationEnriched/htmlEnriched flags); unit-aware durations; TTLCache w/ cap; removed dead suppressedMobileCount; deduped asRecord/asTrackArray/toType; minExpectedCoverage helper.
- **A3b** `ba30849` + `076b671`: getTrackList empty-array fall-through; discover identity gate (no release-only lock); track-index keys on track_id only; removed dead probe-log throttle; consolidated identical normalizeUrl into `src/utils/url.ts`; documented the two intentionally-divergent readTrackIdFromUrl readers (strict metadata vs forgiving playlist).
- **A3c** `eb8244c` (discover metadata): closed release-only identity locks (trackId only from observed audio; identity fallback gated to track-matched); payload tralbumId no longer falls back to trackId; deleted dead scorePayloadItem/pickPayloadMatch; consolidated toId/toType; renamed discover `normalizeUrl`→`normalizeFullUrl` (distinct full-URL grammar).
- **A4a** `b4cff32`: removed Math.random jitter from toBackoffMs (deterministic); deleted dead focused-truth.ts + helpers.
- **A4b** `b55d002`: synchronous in-flight reservation in mutation runToggle (fixes double-toggle race); deleted dead background mutation engine (handleToggleWishlistItem + helpers + router cases + TOGGLE_WISHLIST_ITEM type).
- **A4c** `328e68e`: unit-aware durations in resolver-tracklist; documented latent B1 (selectedTrackIndex vs scored-primary) and A3 (query-blind byStream).
- **A4d** `5c91741`: hasCachedBpm normalizes lookup key (matches setCachedBpm); bpm<=0 treated as missing.
- **A5a** `37c0b96` (controller core): deleted 4 dead `helpers.ts` exports + 2 now-dead privates + 9 unused imports (−242 lines); removed dead `keySeed` param from `maybeStartNowPlayingAnalysis` + 5 call-site seed args (killed a per-render template + `Date.now()` interp); extracted `resolveNowPlayingTrackId()` (collapsed 6 identical sites); extracted `keyOf()` in refreshLikeSnapshot (deduped 2 lines); clear `playlistConfidenceByCacheKey` in both reset groups (matches siblings). Both builds clean.
- **A5c** `5d07ae8` (analysis attempts) + `984ccc1` (discover cleanup): fixed the
  now-playing `attempts=3` inflation — `registerAttempt` (`analysis-request-controller.ts`)
  now gated on `!cached.hasBpm` so cache hits / cancel-retries no longer count as
  analysis attempts (shared player+discover; mirrors the adjacent `setTrackAnalyzing`
  gate). Removed dead `getCurrentSource`/`currentRuntimeSource`/`setCurrentSource`
  override plumbing in `runtime-audio-controller.ts` (return `controller` directly).
  Removed dead `clearPlaylistTrackAnalyzing` callback (discover interface + `controller.ts`
  wiring; never called). Merged two identical `settled && idle` predicate blocks in
  `syncDiscoverPreloadQueue`. Both builds clean. **Confirmed by 2026-06-16 re-capture:**
  all tracks incl. now-playing show `attempts=1`; seeks→runtime takeover, `underruns=0`.
- **A5d** `48cc185` (metadata + identity): reconciled the 3rd `readTrackIdFromUrl`
  fork — deleted discover `metadata/normalize.ts`'s own copy; `index.ts` + `payload.ts`
  now import the resolver's reader (`phase.ts`/`helpers.ts`/`controller.ts` already did).
  Behavior-identical for real CDN stream URLs (resolver is the same forgiving reader,
  query-first + numeric-tail + stream_redirect handling; both have the blind `\d{6,}`
  fallback that's unreachable for `/mp3-N/<id>` inputs). Deduped `phase.ts`
  `isApiMetadataSource`/`isMissingMetadataValue` (import canonical; defaults all `---`,
  byte-equivalent) and removed a redundant double `cloneMetadata`. Both builds clean.
- **A5b** `24ea64e` (origin bridge): removed dead `attempt` (always `'single'`) + `data` (parsed body, never read) fields from `runLikesMutation` returns + `index.ts` bridge-result mapping + `LikesMutationBridgeResult` type. Both builds clean. Verified non-issues: bridge-level wishlist dedup is redundant (already guarded by 4b synchronous in-flight reservation in `mutation-controller.ts`); the `runLikesMutation` post-loop return (645-651) is NOT dead — TS control-flow requires it.

## Carryovers / resolved

- **3b fan-id (R3 C3)** → resolved in 4a: `getFanIdFromGlobals` (page-first) is
  debug-only; likes uses `viewer-id.ts` (viewer-first). No bug.
- **3b C3 track-array divergence** → confirmed end-to-end in 4c, latent (shadowed
  by `byTrackId`), documented; real fix is in the deferred refactor below.

## Carryovers from 5a (to resolve in later 5x sub-passes)

- **double auto-advance (latent race) — DOCUMENTED, NO FIX (debugger-confirmed clean):**
  5b verified the origin `ended` emission at `origin-bridge/script/section-a.ts:452`
  is not owner-gated (the runtime-suppression early-return at 380-396 only covers
  `play`/`playing`), so in principle a runtime-owned origin element that fired `ended`
  could post `DISCOVER_AUDIO_ENDED` and, with two ended→advance triggers (runtime
  `onPlaybackEnded` ~2147 + origin observed-ended in `syncFromDiscover` ~2604), cause a
  B→C double-skip if origin advanced A→B first and the runtime path then computed its
  1500ms dedup key from the now-current B.
  **A 2026-06-16 discover auto-advance Copy All falsified the practical risk and the
  proposed fix:** (1) the advance was a single clean `auto-next-track from=1 to=2
  origin=origin-ended` → clean ping-pong takeover (`host-output-drain holdMs=198`,
  `underruns=0`); (2) `runtimePlaybackOwned` is already `false` at natural end
  (ownership resets to `origin-started firstOrigin=1` BEFORE the advance), so the
  proposed "gate origin-ended on `!runtimePlaybackOwned`" is a no-op — owned is false
  regardless of trigger; (3) the origin `<audio>` was frozen `paused=1 t=14.84/420.26`
  (paused mid-track at the seek handover), so it structurally cannot emit the `ended`
  the race needs. Existing dedup (`lastAutoAdvanceTrackKey` + `lastHandledDiscoverEndedAt`)
  handled the observed case. Per audio-rules §9 / no-speculative-guards: no change.
  **If a real double-skip is ever observed:** route both ended paths through one dedup
  keyed on the ENDED source (not post-advance `nowPlaying`).
- **5a → perf pass — per-render recompute:** `render()` runs full
  `refreshLikeSnapshot()` (O(n) double-pass) + analysis decorations every call,
  and render fires from the 900ms poll, every transport action, every runtime STATE
  tick, and every warm step. Gate on a change signature. Measure first; aligns with
  discover-perf target.
- **5a — documented, no fix:** `resolveTrackLikeIdentity` (controller.ts ~947-978)
  borrows the current track's id for a playlist row lacking its own `trackId` via the
  fallback chain — latent, deduped out by `itemId` in `resolveFocusedTrackLikeIdentities`.
- **5a → 5d — phase.ts duplication:** `phase.ts` re-defines `isApiMetadataSource` /
  `isMissingMetadataValue` and overlaps `isResolverMetadataReady` with controller's
  `isDisplayMetadataReadyForCurrentSource`. Fold into a metadata-readiness consolidation.
- **5a — group-A keyAnalysis-clear omission:** the track-jump reset group (clears
  bpm/waveform/failed/attempt/confidence) omits `playlistKeyAnalysisByCacheKey.clear()`
  that the deactivate group has. May be intentional (key re-derives from BPM). Confirm.

### 5c lead — RESOLVED + CONFIRMED in A5c

- **Current track BPM `attempts=3`** — root cause: `registerAttempt`
  (`analysis-request-controller.ts:909`) fired before the cache short-circuit (917),
  so cache hits (became-current re-request + cancel-retry with cleared dedup key)
  counted as attempts. Fixed by gating `registerAttempt` on `!cached.hasBpm`.
  Confirmed: 2026-06-16 re-capture shows now-playing `track[i]` at `attempts=1`.

### 5c deferred to createPreloadEngine refactor (drift, dormant with keyAnalysisEnabled=0)

- keyAnalysis write (`preload-controller.ts:389`) lacks an `outcome !== 'cancelled'` gate.
- `cancelDiscoverPreloadKeyPass` (426) doesn't `flushDeferredWaveforms` (player flushes).
- `onTrackComplete` BPM write (369) lacks a runId guard (already in the refactor list).
- cancelled-branch attempt decrement (357-364) shares one map with the standalone path.
- Minor in-file: `getSettings()` carries 2 unused fields; `getPreloadKeyAnalyzingCacheKeys`
  getter unused; epoch-terminal scan recomputed twice per sync tick (685/763).

### 5d discuss / documented (not changed — identity-sensitive, mostly dormant)

- **Cross-release identity leak in `pickStrictApiPayloadCandidate`** (`metadata/index.ts:61`):
  on a release mismatch the payload path returns `byTrack[0]` (same track id, different
  release URL) whereas the bridge path (37) correctly rejects a mismatch. Could lock a
  wrong-release album identity (tralbumId/bandId) when the same track id appears under two
  release URLs. **Dormant in practice** — all live captures show `payloadResults=0`
  (metadata resolves via TralbumAPI, not the discover payload). Recommended tightening if
  reopened: when `wantedRelease` is set but unmatched, return `null` (match the bridge
  path) so identity falls to the track-matched hint / authoritative API+HTML resolution.
  Identity behaviour — needs a real nested payload + user call before changing.
- **Identity uses the FORGIVING reader, not the strict one:** `metadata/index.ts`
  `audioTrackId` feeds identity but reads via the forgiving resolver reader (blind
  fallback included). `resolver-url.ts`'s header says identity should use the STRICT
  reader (`metadata/common.ts`). Unreachable mis-ID for real `/mp3-N/` inputs, so left
  as-is; revisit if identity is ever sourced from non-stream URLs.
- **like-controller (low-confidence, latent):** `activeSyncFocusKey = next || active`
  (line ~184) retains the old focus key when the next identity hasn't resolved, so a
  focus change to an unresolved track may not hard-reset an in-flight sync (brief wrong
  like-button state). `runWishlistToggle` silently clamps an out-of-range `trackIndex`
  to `currentIndex` (~362) — a reorder race could toggle the wrong track. Documented.
- **Minor (left):** `DiscoverNowPlaying.sources` (debug-only) recomputed on every
  `getDiscoverNowPlaying`; `getStreamPathKey` double-parses; debug-path re-scans payload.

### 5b origin-bridge simplification opportunities (simplicity-first; not yet done)

- **Duplicate identity-scan walkers** (`origin-bridge/script/section-b.ts` vs
  `section-c.ts`, ~120 lines of copy-pasted band/tralbum/track-id extraction +
  string-reparse queue). Single biggest bridge simplification. Med-risk merge (the
  two differ in roots/limits/budgets) — candidate for a focused simplification pass.
- **Triple full-window scan on every fetch/XHR** (`section-c.ts` network hooks run
  `scanWindowForTrackIdentity` + `scanWindowForDiscoverPayload` + `scanPerformanceForHints`
  synchronously per JSON response, on top of the 2-3s timers that already run them).
  Redundant hot-path work; rely on timers/events or debounce.
- **Duplicate `DISCOVER_OBSERVED` posts** (`section-c.ts`) bypass the
  `postObservedDiscoverPayload` dedup+validation the window-scan path uses — unify.
- **`load-track` origin-mode branch** (`section-a.ts` ~744-775) is unreachable (every
  caller passes `detached:true`; only `runtime-audio-controller.ts:64`'s
  `detached ?? false` default keeps it nominally live). Removing collapses load-track
  to detached-only. Audio-path — confirm before removing.
- **Bridge listener origin check** (`origin-bridge/listener.ts:32-36` + page-side
  `section-a.ts` listener) validates only `data.source`, not `event.source === window`
  / `event.origin`. Narrow threat (script already in the bandcamp discover page).
  Documented; no speculative guard added.
- **Cosmetic dead:** bridge-type `requestContextVariant?` (types.ts:87, set by sender,
  never read by `runLikesMutation`); constant `phase`/`engine` debug fields.

## Area 6 Plan — UI, Glass & Debug Panel

Surface: ~13.4k lines under `src/ui/` + ~2.3k lines of debug data producers in
`src/content/debug/` (the `src/ui/debug-panel/` renderer consumes these).

Run order (lowest-risk → highest visual risk): **6d → 6b → 6c → 6e → 6a**.
Per sub-pass: parallel correctness (A/B/C) + cleanup (D/E/F) finder agents reading
target files fully → I verify each high-signal candidate against real code → triage
(fix-now / discuss / defer) → fix safe set → `npm run build` AND `npm run build:chrome`
clean → user Copy All sanity capture → commit. Never auto-commit/push; no speculative
guards; large duplication → carryover, not point-fix.

- **6a — Panel shell + glass + global styles:** `panel.ts`, `styles/panel-shell.ts`,
  `styles/glass.ts`, `styles.ts`. GUARD (memory `project_liquid_glass_branch`,
  `feedback_glass_not_bevel`): no bevel gradients, don't touch baked liquid-glass
  defaults / Alt+G tuner / drag-translate. Cleanup only, no visual redesign.
- **6b — Core components + styles:** `components/{transport,playlist-view,metadata-display,
  bpm-display,like-button,tap-tempo,settings,welcome-gate,warning-banner,
  keyboard-shortcuts-panel,performance-confirm}.ts` + `styles/{transport,playlist,
  like-heart,warning}.ts`. Watch per-render recompute (5a `render()` O(n) carryover),
  duplicated DOM builders, listener leaks, dead handlers.
- **6c — Waveform render + interaction (perf-sensitive, isolated):** `components/
  waveform-{canvas,draw,interaction}.ts` + `styles/waveform.ts`. GUARD (memory
  `project_waveform_firefox_cpu_heat` = cached past/future layers + composite, no
  per-frame full redraw; `project_waveform_rgb_model` = v6.2 stacked 3-colour + 4th-order
  filters + RMS). Hunt full-canvas redraws / leaked rAF / detached-canvas retention;
  do NOT alter the RGB/filter model.
- **6d — Debug panel render + anonymization (+ producers boundary):** `debug-panel/
  {index,format,view,clipboard}.ts` + `styles/debug-panel.ts` + producers
  `src/content/debug/*` (esp. `debug-body.ts`, `resource-diagnostics.ts`). GUARD
  (`rules/debug-ui-rules.md`): never rename `heap`/`heapLimit`/`wasmHeap`/`essentiaHeap`
  tokens or emit raw memory under another key; export MUST keep omitting identity/library/
  auth/paths/device/signed-URL tokens; no state/activity split or Activate gate; status
  strip live on hover; resource sampling gated on panel-open. Focus: redaction-completeness
  audit, dead trace fields, double-scan/recompute in body assembly.
- **6e — Key-tuning + tempo/bpm/why-two-keys panels:** `key-tuning/*`,
  `key-tuning-panel.ts`, `tempo-adjust-panel.ts`, `bpm-prototype-panel.ts`,
  `why-two-keys-panel.ts` + `styles/tempo-adjust.ts`. Verify `bpm-prototype-panel.ts`
  live vs dev-only before any removal. Display-only — don't change BPM/key math.

Suggested captures: discover page Copy All (6a/6b/6c); Firefox session-heat (6c);
Copy All on a track page + discover (6d redaction + resource rows).

### 6a — panel shell + glass + deferred items — DONE, commits `7a26d52` (dead CSS) + `8d16fd2` (copyThemeVars)

- **No correctness bugs.** All document/window listeners are removed in destroy()
  (global pointerdown/keydown 1362-1363; drag listeners add-on-mousedown/remove-on-mouseup;
  message listener in controller destroy). The finder's "element listener leak" is a
  non-issue — those are root descendants, GC'd when destroy() removes the tree; panel is a
  page-singleton. Glass model / baked defaults / Alt+G tuner / drag=transform untouched.
- **Dead CSS removed** (`7a26d52`): the deferred legacy BPM-block + playlist classes
  (transport.ts / playlist.ts / panel-shell.ts), surgically (kept interleaved live
  `bc-bpm-label`/`bc-bpm-val`).
- **copyThemeVars helper** (`8d16fd2`): extracted the deferred cross-file theme-var copy loop
  to `src/utils/theme.ts`; perf-confirm + why-two-keys now call it. waveform-draw left as-is
  (TTL cache + fallbacks), panel.ts doesn't copy theme vars.
- **NOT done (low value, panel.ts orchestrator left stable):** click+keydown handler dup —
  the 3 blocks are NOT identical (infoButton's click lacks preventDefault), so a blanket
  helper would change behavior; left. Redundant keyboard-shortcut normalize at panel.ts:1128
  — one-time construction cost, needs init-order proof, skipped.

### 6e — key-tuning + tempo/why-two-keys/bpm panels — DONE, commit `38e42ba`

- **Real BUG fixed:** `parseReferenceCamelot` (`key-tuning/reference.ts`) mis-parsed
  reference keys `10A`/`11A`/`12A` → `1A`. The exact-match path matched the camelot but
  then RE-matched the digit with `/(?:[1-9]|1[0-2])/`, whose ordered alternation returns
  `"1"` first for two-digit numbers. Fixed by capturing the digit group in the single
  match `^(1[0-2]|[1-9])\s*([AB])$` (mirrors the correct `render.ts` reader). Reachable via
  the user reference-key input (key-tuning-panel.ts:116/233). node-repro confirmed before+after.
- **Dedup:** exported the identical 24-entry `KEY_NAME_TO_CAMELOT` from `reference.ts`;
  `render.ts` imports it and dropped its byte-identical local copy.
- **Rejected (verified):** `normalizeCamelot` merge between `render.ts` and `decision.ts`
  (decision's is intentionally STRICT — no zero-width strip / `\s*` / embedded / name lookup;
  it feeds AUTO/REVIEW/REJECT, merging would change decisions). `bound`-flag desync (hide
  DOES reset `bound=false`, line 368). stale `refs!` handlers (DOM removed when refs nulled;
  only a sub-ms clipboard `.then` race, caught — no corruption). `bpm-prototype-panel.ts`
  is LIVE (9 call sites in `content/player/bpm-prototype.ts`), not dead.
- **Deferred (low value):** `fmt` formatter dup (render.ts:36 default 2 vs key-tuning-panel.ts:89
  default 3); theme-var copy loop (still the cross-file `copyThemeVars` item).

### 6c — waveform (canvas/draw/interaction + styles) — DONE, commit `c928626`

- **No correctness bugs.** Correctness finder self-concluded: rAF loops cancelled in
  destroy(), no leaks, cached past/future-layer architecture intact, DPR handling correct.
  Its leads (canvas initial 320x68 attrs, ResizeObserver no-debounce, palette-TTL
  pathological, playhead width-1, reveal clip) are all low-confidence non-bugs / intentional
  — rejected (no speculative guards). RGB/4th-order/RMS "v6.2" model untouched per memory.
- **Fixes (staged, both builds clean):**
  1. Removed dead exported `setupCanvasForDevicePixelRatio` (`waveform-draw.ts`, was never
     called — grep-confirmed definition-only).
  2. Removed the vestigial always-hidden status element end-to-end: `toStatusText()` was a
     stub returning `''` always, so the `.bc-waveform-status` div was permanently
     `display:none`. Removed the fn, the `WaveformVisualState.statusText` field, the
     snapshot assignment, the change-diff term, the DOM create/append, the render write,
     AND the now-dead `.bc-waveform-status` + `.bc-waveform-ready .bc-waveform-status` CSS
     rules. All refs accounted for; constant-`''` so provably inert.
- **Minor left (low value, not done):** dead class toggles `bc-waveform-idle`(622)/
  `bc-waveform-seek-pending`(624) have no CSS rule and nothing reads them, but left as
  possible semantic state hooks; `clamp01` dup (waveform-interaction vs the 9x inline
  `Math.max(0,Math.min(1,...))` in waveform-canvas) — fold into the cross-file clamp/util
  consolidation if one happens; loop-invariant `Number(lowerConst||0)` in drawBandArea is
  build-time (not per-frame), negligible.

### 6b-2 — auxiliary panels (like-button/tap-tempo/settings/welcome-gate/banners/shortcuts/perf-confirm) — DONE, commit `d9e8605`

- **No correctness bugs.** like-button disabled-vs-aria-disabled "mismatch" is the
  intentional SOFT-DISABLE pattern (during sync the button is aria/visually disabled but
  stays clickable; native `disabled` only when you own the album). welcome-gate
  listener-not-removed + async-after-destroy are created-once/destroyed-once and
  optional-chaining-safe — no fix.
- **Fix (staged, both builds clean):** removed dead `softDisabled` in `components/
  like-button.ts` (declared/assigned/written to `data-softDisabled`, read by nothing —
  CSS uses the `.bc-btn-album-like-disabled` class). 3 lines removed.
- **Rejected finder bad advice:** "remove `aria-pressed`" in keyboard-shortcuts-panel is
  WRONG (a11y attribute, not redundant with the visual `is-capturing` class).

### 6b-2 → DEFER — theme-var copy dedup (cross-file shared helper)

`getComputedStyle` + per-var `setProperty` copy loop is duplicated across `panel.ts`(6a),
`performance-confirm.ts`(6b-2), `waveform-draw.ts`(6c), `why-two-keys-panel.ts`(6e) — two
have explicit var-list consts (`PERF_CONFIRM_THEME_VARS`, `PANEL_THEME_VARS`). Extract one
shared `copyThemeVars(source, target, vars)` util and update all callers in a single pass
(don't scatter). Modest value; do alongside 6a or as a dedicated shared-util refactor.

### 6b-1 — core render path (transport/playlist-view/bpm-display/metadata-display + styles) — DONE, commit `15bf2d1`

- **No correctness bugs.** Verified-rejected finder leads: bpm-display idle→play "time
  jump" (`lastInputUpdatedAtMs` resets unconditionally at update(), elapsed≈0 on resume);
  rAF "leak on destroy" (destroy() calls cancelTimeAnimation, zero-window is synchronous);
  volume-drag blur reset (native slider holds pointer capture; no real failure — no
  speculative guard); playlist like double-fire (pointerdown/click `likePointerHandled`
  flag is a correct dedup, exactly one toggle per activation).
- **Fix (staged, both builds clean):** extracted `clampVolumePercent()` in
  `components/transport.ts`, replacing 5 identical inline
  `Number.isFinite(v)?Math.min(100,Math.max(0,v)):100` clamps. Behavior-identical.
- **Cleanup finder UNRELIABLE on CSS — caught two would-be bugs:** it flagged
  `bc-tap-stub`/`bc-tap-ripple` as dead, but they're LIVE (`tap-tempo.ts:133,154`); and
  its "remove all `.bc-bpm-*` (lines 728-779)" was dangerous — `bc-bpm-*` is a big live
  prefix and the dead block is INTERLEAVED with live `bc-bpm-label`(749)/`bc-bpm-val`(756).

### 6b-1 → DEFER to 6a — genuinely-dead legacy "BPM block" CSS removal (cross-file)

Render-safe (classes never applied to any element; `nonstyle=0` verified), but spans
`styles/transport.ts`, `styles/playlist.ts`, AND `styles/panel-shell.ts` (6a), and the
transport block is interleaved with live rules — needs surgical per-rule deletion, do as
one coherent pass in 6a. Verified-dead classes + lines:
- `styles/transport.ts`: `.bc-bpm-block`(728-735), `.bc-bpm-top`(737-741),
  `.bc-bpm-bottom`(743-746) — KEEP live `.bc-bpm-label`(749)/`.bc-bpm-val`(756) between —
  then `.bc-beat-ind`(762), `.bc-camelot-pair`(767), `.bc-cam-val`(769), `.bc-cam-dot`(774),
  `.bc-cam-dot-dim`(778), `.bc-cam-sep`(780). (Comment header line 727 too.)
- `styles/playlist.ts`: `.bc-pl-open-header-icon`(142), `.bc-pl-expand`(388),
  `.bc-pl-collapse`(398).
- `styles/panel-shell.ts`: remove `.bc-bpm-block`(855) + `.bc-pl-expand`(859) from the
  comma-group at 852-864 (KEEP the live siblings + the rule).

### 6d — debug panel render + anonymization — DONE, commit `c2e48c0`

> NOTE: the dedup below was briefly reverted during a "nothing loads" scare that
> turned out to be **first-load fetch warmup, not a regression** (the change is a
> byte-identical debug-render edit and could not affect the data pipeline). The
> resolver sequence `gate=no-tralbum probe=album-unresolved:220 fetchGate=in-flight`
> is the NORMAL cold-fetch window — it resolves to `gate=strict-match … tracks=N`
> within ~1s once TralbumAPI/HTML returns; a ~5s-early capture on a cold (likely
> rate-limited) page load just catches it mid-fetch. Re-apply the dedup before
> continuing 6b if desired.


- **Anonymization contract verified INTACT (no leak).** Export is allow-list based
  (`isAnonymizedEntryIncluded` format.ts:208 default-denies; headings excluded).
  `sanitizeAnonymizedUrl` (161) rebuilds URLs from parsed parts — `stream_redirect`
  keeps only `enc`+`track_id`, structurally dropping the signed token; unknown host →
  `origin/[path omitted]`; malformed → `[url omitted]`. Heap tokens redacted (200), no
  token rename. The `formatAudioSourceSummary url=` "leak" worry is moot (URL is parsed
  + reconstructed, not regex-matched).
- **Fix (staged, both builds clean):** `resolveStatusItems` (index.ts:473) called
  `resolveMetadataSignature(areas)` which re-scanned the same Metadata/confidence/sources
  already read at 469-471 — now builds the signature from the already-read values
  (zero-risk dedup; `resolveMetadataSignature` kept, still used at 842). Awaiting Copy All
  sanity capture + commit.
- **Rejected finder over-surfaces (with reasons):** getSourceEvents "3×" — 2 are
  deferred copy-button click closures (854/861), caching would make copy output stale;
  `metadataText` not dead (used 546); `formatKeyProcessLines` (debug-body.ts:660) trivial
  but documents intent / mirrors siblings — left; regex-per-call + per-tick findEntryValue
  re-scans are open-gated micro-perf, not worth churn (no scattering point-fixes).

## Deferred Refactor Plan (post-Area-7) — START HERE in a new thread

All 7 review areas are committed (see Status). This section turns the scattered
DEFERRED notes below into an executable, fresh-thread plan. It is a **refactor of live
code**, not a dead-code sweep — net line drop is smaller than gross (shared helpers get
added back); the real win is one-source-of-truth + fixing guards that have drifted between
duplicated copies.

### Outcome — executed 2026-06-17 (R1 DONE · R3 measured-out · R2 verified-deferred)

> Each phase was grounded against real code + live debugger captures first; several
> of the doc's premises below turned out stale (same pattern as the area reviews).

- **R1 — DONE**, commits `aef55d9` + `2987a70`. The "4 selectors / 4 stream readers"
  premise was **stale**: `getTrackList`/`getTrackRows`/`buildTrackQuality` live in the
  metadata-extractor + background and are intentionally divergent (not dups), so they
  were left. Shipped: `sorter.ts` `compareByKey`/`compareByKey2` → `compareByKeyField`;
  `resolver.ts` `buildAnnotatedTracksFromTralbum` extraction; **A3 fix** (match
  `streamContentId` before the query-blind `byStream`); **deleted dead**
  `resolveDiscoverPlaylistFromGlobals` + `resolveDiscoverCurrentIndex` +
  `DiscoverPlaylistResolveResult` (zero callers — discover resolves via
  `resolveNonReleaseResolverSnapshot`); shared `clamp` → `src/utils/number.ts` (only the
  2 shared-realm callers; the worker/UI/inline clamps were left — divergent NaN/fallback
  policy, volume→1 vs fraction→0). **B1** (`selectedTrackIndex`) left documented:
  cross-subsystem, and captures show it's never reached (`match=audio.trackId` always).
- **R3 — MEASURED-OUT, no changes.** A 20-track discover capture caught the exact resync
  storm (7 `onTrackComplete` in 32 ms); content-thread lag stayed **avg ~2.7 ms** (max
  48 ms was the one-off cold paint, present even in the 3-track capture). `decoratePlaylistTracks`
  is already O(n) + per-row short-circuit; the O(n²) caller lives in `preload-controller.ts`
  (R2 surface), is sort-by-bpm-entangled, and produces **no measurable jank**. Discover
  doesn't even instrument `render=`/`panel=`. `PlaylistAnalysisCacheFacade` is **not** a
  thin shim (`hasCachedBpm`/`setCachedBpm` carry normalization + change-detect) — kept.
- **R2 — VERIFIED-DEFERRED, no changes.** Read both preload controllers + `preloader.ts`
  fully. The 4 "drifted guards" do not survive inspection: **#1** runId-on-BPM-write is
  benign (writes keyed by track cacheKey — a late completion is still correct data; a
  guard would discard good cache); **#2** discover keyAnalysis `!cancelled` gate is
  unreachable (`preloader.processOne` sets `outcome='cancelled'` only when `result===null`,
  preloader.ts:224-226); **#3** deferred-waveform flush is already consistent (both flush
  in the `syncKeyQueue` key-disabled branch; neither in `cancelPass`); **#4** double-enqueue
  is already handled (`filterPreloadTargets` `skipAnalyzing` + `preloader.dedupeTargets`;
  captures show all `attempts=1`). The extraction is a ~1000-line rewrite of a
  measured-clean, most-guarded live path for **maintainability only** → deferred. If
  reopened: only worthwhile if the path needs changing anyway; guard **#2** is the one
  1-line consistency hardening to apply *if* the preloader ever starts returning partial
  results on cancel.
- **R4** — untouched (evidence-gated investigations; independent, needs real payloads).

### Method (same as the area reviews)
1. Read the GUARD docs first: `rules/wishlist-and-collection.md` (mutation ownership +
   deterministic pacing + no speculative retries), `rules/bpm-analysis-rules.md`
   (one-stage-one-job; never restart a settled BPM), `rules/audio-rules.md` (runtime
   preload/handoff) for R2.
2. Per phase: read the target files FULLY, make the change behavior-preserving, then
   `npm run build` AND `npm run build:chrome` clean.
3. **Never auto-commit / never push** (project hook hard-blocks push). Commit only when
   asked. For R2/R3 (live preload + render path) get a debugger **Copy All** before AND
   after, on BOTH a player page and a Discover page.
4. No speculative guards; no new deps; keep retry/pacing deterministic.

### Run order (lowest → highest risk): R1 → R3 → R2, with R4 anytime (independent)

- **R1 — Pure helper extraction (low risk, mechanical, mostly line-neutral→down).**
  Surface: `playlist/resolver.ts` (660), `resolver-tracklist.ts` (594), `sorter.ts` (137),
  plus the cross-file clamp callers (`shared/key-confidence.ts`, `shared/tempo-adjust.ts`,
  `ui/components/waveform-*`).
  - Unify the **4 track-array selectors** (`getTrackLists` / `getTrackList` / `getTrackRows`
    / `buildTrackQuality`, in `resolver.ts` + `resolver-tracklist.ts`) and the **4 stream
    readers** into shared helpers — this is what closes the latent **B1** (selectedTrackIndex
    vs scored-primary) and **A3** (query-blind byStream) carryovers at the root.
  - Extract **`buildPlaylistFromTralbum`** (the ~140-line Tralbum→playlist builder currently
    duplicated ~3× across resolver paths — does NOT exist yet, this is the new helper).
  - Dedup **`compareByKey`/`compareByKey2`** (`sorter.ts:33`/`54`) into one keyed comparator.
  - Cross-file **`clamp`/`clamp01`** → one shared util with an explicitly-chosen NaN policy
    (key-confidence does NaN→min; tempo-adjust doesn't; waveform inlines `Math.max/min` 9×).
    Pick the safe semantics, prove each call site is unaffected, then replace.
  - Hoist per-`currentSrc` trackId parsing OUT of per-track loops (F1–F5).
  Verify: tsc/both builds; playlist still resolves + sorts identically (Copy All: Playlist
  source, track rows, sort order unchanged).

- **R3 — track-selection split + render/perf (medium risk).**
  Surface: `track-selection-dom.ts` (273), `analysis-cache.ts` (202),
  `analysis-decoration.ts` (127), the panel `render()` path (5a carryover).
  - Split prev/next nav out of the 273-line `track-selection-dom.ts`.
  - Kill the per-single-row-BPM **full re-sort + re-decorate with O(n²) cache-key rebuild**
    (F10/F13) — recompute only the changed row.
  - Drop the `PlaylistAnalysisCacheFacade` pass-through if it's still a thin shim.
  - **`render()` per-call recompute** (5a): `render()` runs full `refreshLikeSnapshot()`
    (O(n) double-pass) + analysis decorations every call, fired by the 900 ms poll + every
    transport action + every runtime tick. Gate on a change signature. **Measure first**
    (UI performance render=/panel= lines in Copy All) — this is perf, aligns with the
    discover-perf target; don't change output, only skip redundant work.
  Verify: Copy All before/after — render/panel ms drop, playlist + like state identical.

- **R2 — `createPreloadEngine` (the big one, highest risk).**
  Surface: `player/preload-controller.ts` (964), `player/preloader.ts` (366),
  `discover/preload-controller.ts` (793) — player + discover are ~75% duplicated.
  - Extract **`createPreloadEngine(identityAdapter, buildQueue, callbacks)`** and route both
    controllers through it.
  - Fix these drifted guards ONCE inside the engine (they differ between the two copies today):
    1. `onTrackComplete` BPM write needs a **runId guard** like the key path's `shouldApply`
       (today it writes BPM before the runId check — bounded: leaked cache writes keyed by
       track identity, not wrong-track display).
    2. discover `keyAnalysis` write needs the **`outcome !== 'cancelled'` gate** the player has.
    3. **deferred-waveform flush** on `cancelPreloadKeyPass` (player flushes, discover doesn't).
    4. **double-enqueue guard** — `setQueue` must exclude already-active targets.
  - Also fold in discover-perf F1 (player rebuilds full debug snapshot per trace append) and
    F2 (discover re-parses tracklist URLs 2–3× per 12 s audit tick) if cheap inside the engine.
  Verify (REQUIRED, both pages): Copy All before/after on a player page AND a Discover page —
  preload `prepared=N/N state=complete`, all tracks `attempts=1`, no double-enqueue, waveform
  flush on cancel, runtime takeover + `underruns=0` on seek. This touches the live analysis +
  preload path — treat like Area 1/2/5, get debugger sign-off before commit.

- **R4 — evidence-gated investigations (independent; NOT deletion).** Do only with a real
  captured payload/dump; each is behavioral, not a line-cut:
  - **Sync request-pacing** (4a/4b): why Bandcamp's per-fan limiter is already throttling at
    first page load (>1 min initial likes sync; honored `retryAfterMs≈29s` × 429s). Backoff is
    already deterministic — this is *why it engages*, not a backoff bug.
  - **3a A4** coverage-score weight redesign (a 1-track direct release can outscore a 50-track
    album) — needs a real nested payload to validate.
  - **3a B3** instrument the low-direct-stream HTML trigger.
  - **Latent identity guards** (4a B6/C1/C4) — defensive against hypotheticals; background is
    viewer-correct today. Leave unless a real cross-fan case appears.

### Rough size expectation
Gross removable is largest in R2 (~1.7k combined preload lines → one engine) and R1 (selectors
+ builder + comparator). Expect a few hundred NET lines down once the shared engine/helpers are
added back, plus 4 guard-drift bugs fixed for free. R3 is perf-positive, roughly line-neutral.
R4 is correctness/investigation, not deletion.

## DEFERRED — consolidated "playlist/preload refactor pass"

One dedicated refactor (duplicated orchestration + hot-path waste, all
discover-perf-aligned). Do NOT scatter point-fixes; fix at the root:

- **From 4c:** unify the **4 track-array selectors** (`getTrackLists` /
  `getTrackList` / `getTrackRows` / `buildTrackQuality`) and **4 stream readers**
  into shared helpers — closes the B1/A3 carryover at the root. Extract
  `buildPlaylistFromTralbum` (resolver.ts ~140 lines 3× duplicated). Hoist the
  per-`currentSrc` id parsing out of per-track loops (F1–F5).
- **From 4d:** kill the per-single-row-BPM full re-sort + re-decorate with O(n²)
  cache-key rebuild (F10/F13). Split prev/next nav out of the 273-line
  `track-selection-dom.ts`. Dedup `compareByKey`/`compareByKey2`. Drop the
  `PlaylistAnalysisCacheFacade` pass-through.
- **From 4e:** extract **`createPreloadEngine(identityAdapter, buildQueue,
  callbacks)`** — the player and discover preload controllers are **~75%
  duplicated** (~600 lines each). Fix these guards/gates ONCE inside it (they've
  drifted between the two copies): BPM completion needs a runId guard like the key
  path's `shouldApply` (currently `onTrackComplete` writes BPM before the runId
  check — bounded impact: leaked cache writes keyed by track identity, not
  wrong-track display); discover `keyAnalysis` write needs the `outcome !==
  'cancelled'` gate player has; deferred-waveform flush on `cancelPreloadKeyPass`;
  double-enqueue guard (setQueue doesn't exclude already-active targets). Plus
  discover-perf F1 (player rebuilds full debug snapshot per trace append) and F2
  (discover re-parses tracklist URLs 2–3× per 12s audit tick).

## DEFERRED — other parked items

- **Sync request-pacing (from 4a/4b):** why Bandcamp's per-fan rate limiter is
  already engaged at first page load → >1 min initial likes sync (server
  `retryAfterMs≈29s` × multiple 429s, honored correctly). The deferred 4a "sync
  eligibility / rapid origin-jump pacing" item. A behavioral investigation of its
  own — candidate for a focused pass. (Not a backoff bug; backoff is now
  deterministic and correct.)
- **3a A4:** coverage-score weight redesign (directStreamCoverage dominates track
  count — a 1-track direct record can outscore a 50-track tokenized album). Needs
  a real nested-payload to validate.
- **3a B3:** instrument the low-direct-stream HTML trigger (does it fire on normal
  tokenized payloads? — now bounded by the once-per-dimension enrichment cache).
- **Latent identity guards (4a B6/C1/C4):** background is viewer-correct today;
  cross-fan snapshot assertion / resolveFanId-trusts-this.fanId / page-owner-slug-
  as-hint are defensive against hypotheticals. Left per "no speculative guards."

## Area 7 Plan — Background Infrastructure & Shared

Surface (excluding the `audio/`, `key/`, `tempo*` math already owned by A1/A2 — A7
reviews only their *infrastructure wiring*): routing + entry glue under
`src/background/{router-core,init}.ts` + `src/targets/{chrome,firefox}/background/*`
(+ Chrome offscreen host); caches (`cache.ts`, `likes-cache.ts`,
`persistent-bought-likes-cache.ts`, `encoded-audio-cache.ts`, `utils/cache.ts`);
worker-pool + concurrency; `src/shared/*`; `src/utils/*`.

Method unchanged. No dedicated background-rules doc — `rules/architecture-rules.md`
is the contract. Run order (lowest → highest risk): **7a → 7d → 7b → 7c**.

- **7a — Routing & entry glue:** `background/router-core.ts`, `init.ts`,
  `targets/{chrome,firefox}/background/{index,router}.ts`, `targets/chrome/background/
  {offscreen-manager,handlers/*}.ts`, `targets/chrome/offscreen/analysis-host.ts`.
  Dispatch-coverage vs `shared/types` ContentMessage union; core-vs-Chrome dispatcher
  drift; listener register/teardown. GUARD: Firefox/Chrome are separate products.
- **7d — Shared types & utils:** `shared/{types,constants,debug-trace,
  runtime-predecode-policy,key-confidence,tempo-display,tempo-adjust,concurrency,
  resource-sampler,track-id,chrome-analysis-host-types}.ts` + all `src/utils/*`. Dead
  exported types/consts; cross-file dup-util consolidation (clamp01 / normalizeUrl
  carryovers land here). GUARD: don't change predecode/key-confidence thresholds.
- **7b — Caching layer:** `cache.ts`, `likes-cache.ts`,
  `persistent-bought-likes-cache.ts`, `encoded-audio-cache.ts`, `utils/cache.ts`.
  TTL/cap/eviction; key-normalization consistency (cf. A4d `hasCachedBpm`); set/get
  key mismatches; unbounded growth. GUARD: `wishlist-and-collection.md` — don't touch
  like/wishlist cache identity or mutation ownership.
- **7c — Worker pool & concurrency (highest risk, touches A2 path):**
  `audio/worker-pool.ts`, `shared/concurrency.ts`, worker/offscreen handoff,
  `analysis-audio-fetch.ts` fetch concurrency, `resource-sampler` gating. Deterministic
  pacing/queue limits; leaked/never-settled jobs; pool-init vs first-request race;
  cancel propagation. GUARD: `bpm-analysis-rules.md` + `audio-rules.md`; deterministic
  only — no random timing, no speculative recovery.

Suggested captures: track-page Copy All (7a routing + 7b caches + worker-pool rows);
discover-page Copy All (7c concurrency under load).

### 7c — worker pool & concurrency — DONE, commit `db5ecee` (verified live: pool 12/12, dispatch=pool, preload all attempts=1)

Surface: `audio/worker-pool.ts` (582), `shared/concurrency.ts` (24, reviewed in 7d — clean),
`handlers/analysis-audio-fetch.ts` (415, fetch concurrency), `resource-sampler` gating.
GUARD `bpm-analysis-rules.md` §1/§9 + `audio-rules.md`: keep the SW-thread fallback, keep
rhythm on the pool, return full `{bpm,confidence,ticks,estimates,bpmIntervals}`, deterministic
pacing only. Honoured — the change is dispatch boilerplate only; no pacing/routing/vector change.

- **Fix (behaviour-preserving dedup, both builds clean):** `worker-pool.ts` had FOUR public
  methods (`estimateTempo`/`extractRhythm`/`computeHPCPChunk`/`computePrefilterChunk`) repeating
  an identical dispatch skeleton — init-check, the `findIdleSlot()`→`sendToSlot` vs `queue.push`
  race, and the `error`/non-`result` reply checks. Extracted a private
  `dispatchToWorker(request, transferList, errorLabel)` returning the narrowed
  `Extract<WorkerResponse,{type:'result'}>`; each method now just builds its request and maps
  its own result fields. Per-method error labels preserved via `errorLabel`. Also inlined the
  dead `const id = nextId()` local into `id: nextId()` (id was only ever used in the request).
  Net ~70 lines of duplication removed; the slot/queue race logic now has ONE definition.
  The idle-slot pick + `sendToSlot`'s synchronous `setSlotBusy(true)` run in the same sync tick,
  so no two dispatches can grab the same slot — unchanged by the extraction.
- **`analysis-audio-fetch.ts` reviewed — clean (Area-1/2 territory):** shared-encoded single
  download, `getOrCreateDecodedAudio` in-flight join, `scheduleFullAudioUpgrade` dedup +
  count/latest-promise bookkeeping, and the `partialFetchDisabled` session latch are all
  deliberate, deterministic, and product-relied-upon. No concurrency bug.

#### 7c — DOCUMENTED, NOT FIXED (latent robustness, no speculative recovery per rules)

- **Errored worker slot is never revived:** `handleWorkerError` sets `slot.ready = false` and
  only `warm-up` ever sets `ready = true`, so a post-init worker crash drops that slot for the
  session (pool attrites toward the SW-thread fallback). Reviving = a new re-spawn recovery path;
  left out per "no speculative recovery". WASM worker crashes are rare.
- **Queued job has no timeout until dispatched:** only `sendToSlot` arms a timer; a job sitting
  in `this.queue` has none. Under normal saturation the 30 s in-flight `REQUEST_TIMEOUT_MS` fires,
  frees slots, and `drainQueue` dispatches the queued job (which then gets its own timer), so it
  self-drains. The only hang is "all ready slots error WHILE a job is queued" (also `handleWorkerError`
  doesn't call `drainQueue`) — which also means analysis is broadly down. Low severity; documented,
  no queue-level timeout added (would be a speculative guard).

### 7b — caching layer — DONE, commit `f8977fc` (both builds clean)

Surface: `background/cache.ts` (analysis-result cache), `likes-cache.ts` (shared likes,
in-mem), `persistent-bought-likes-cache.ts`, `audio/encoded-audio-cache.ts`, `utils/cache.ts`
(`TTLCache`, already trimmed in 7d). GUARD `wishlist-and-collection.md`: don't touch
like/wishlist cache IDENTITY or mutation ownership — honoured (no identity/merge changes).

- **Fix (zero behaviour change, both builds clean):** the `chrome.storage` Promise
  wrappers `getStorageArea`/`storageGet`/`storageSet` were byte-identical copies in
  `cache.ts` and `persistent-bought-likes-cache.ts` (the repo's ONLY two storage callers).
  Extracted to `src/utils/extension-storage.ts` (`storageGet`/`storageSet`/`storageRemove`);
  both files import it and dropped their now-unused `browserApi` import. −~45 dup lines.
- **Clean (no bug):** `likes-cache.ts` (monotonic `updatedAt` guard rejects older snapshots,
  TTL expiry + delete) and `encoded-audio-cache.ts` (trackId-keyed single-download dedup,
  TTL+cap prune, `slice(0)` private copies, run-to-completion fetch) are both correct.
  `cache.ts` persistence is solid: epoch-guarded loads/writes, serialized write-chain,
  debounced + awaitable-durable flush for the MV3 SW-suspend window, defensive `revive`.

#### 7b — DOCUMENTED, NOT FIXED (latent / GUARD-protected)

- **`clearAllAnalysisCaches` repopulation race (latent, low-severity):** clear bumps
  `cacheEpoch`, clears the in-mem maps, sets `persistedLoadPromise = null`, THEN
  `await storageRemove(KEY)`. A `getCachedAnalysis` landing in that await window starts a
  fresh `ensurePersistedCacheLoaded` whose `loadEpoch` reads the ALREADY-bumped epoch, so
  the `loadEpoch !== cacheEpoch` guard passes and it repopulates the just-cleared cache from
  the not-yet-removed storage payload → clear partially undone (entries are version+TTL
  valid, so no corruption). Only reachable via the manual debug "clear caches" action
  concurrent with a load. **Fix when confirmed:** gate reloads behind the removal —
  `persistedLoadPromise = storageRemove(KEY).then(() => undefined); await …; persistedLoadPromise = null;`
  (closes the window even when the promise was already null at entry). Not applied this pass:
  unobserved, low-severity, and the fix slightly overloads the load-promise — matches the
  5a/5d "document latent race, don't speculative-guard" discipline.
- **`persistent-bought-likes` monotonic union growth (GUARD — likes identity):**
  `writePersistentBoughtLikesCache` unions collection id/url arrays with the existing
  snapshot and never shrinks, so an un-collected item's id persists indefinitely (no TTL,
  unlike shared-likes). Deliberate "persistent bought" accumulation; authoritative reconcile
  lives in `content/likes/inventory.ts`. Identity territory — left untouched per GUARD.
- **`ensureLoaded` missing try/catch (inert):** unlike `cache.ts`'s loader, persistent
  `ensureLoaded` has no try/catch, so a rejection would stick a rejected `loadPromise` for
  the session. `storageGet` resolves-only (never rejects) and `normalizeSnapshot` is
  defensive, so unreachable today — no speculative guard added.

### 7d — shared types & utils — DONE, commit `4f77803` (both builds clean)

Dead-export scan across all of `src/shared/*` + `src/utils/*` (count refs outside the
defining file, then full-grep the candidates to separate truly-dead from internal-only).

- **Fixes — 5 verified-dead deletions (zero behaviour change, both builds clean):**
  1. `shared/constants.ts`: removed 5 dead consts — `PANEL_POS_KEY`,
     `DEBUG_PANEL_POS_KEY`, `PLAYLIST_EXPANDED_KEY`, `AUTO_PRELOAD_KEY` (leftover
     panel-position / playlist-expand / auto-preload storage keys — neither the const
     NOR its string-literal value appears anywhere else) and `TRALBUM_API_URL` (the
     tralbum fetcher builds URLs via `handlers/tralbum/attempt-urls.ts`; sibling
     `COLLECTION_SUMMARY_API` stays — it IS used by `handlers/likes.ts`).
  2. `shared/tempo-adjust.ts`: removed `createDefaultTempoAdjustControlState` — no
     caller anywhere; the two live consumers (`content/tempo/controls.ts`,
     `ui/components/tempo-adjust-panel.ts`) build control state inline. Cascade checked:
     `TempoAdjustControlState` (param of `buildTempoAdjustUiState`) and
     `TEMPO_ADJUST_DEFAULT_MASTER_TEMPO` (3 external users) both stay.
  3. `utils/cache.ts`: removed the entire dead `DeduplicatedCache` class (42 lines).
     `TTLCache` (the other export) is live and untouched.
  4. `utils/dom.ts`: removed dead `css()` helper.
  5. `shared/types.ts`: removed dead `PlayerStateSnapshot` interface — standalone, not
     composed into any other type and never imported.
- **Verified non-issues / left (no fix):**
  - Over-exported-but-internal symbols (`createDefaultLikeInventoryCounts` /
    `createDefaultLikeMutationDebug` called by `createDefaultLikesDebugSnapshot`;
    `isRefiningTempoStatus`; `DEBUG_CLEAR_CACHES_EVENT`; `SECTION_ORDER`/`SECTION_TITLES`/
    `classifyDebugLine`; the `RUNTIME_PREDECODE_*` tier consts) — used within their own
    file; dropping the `export` keyword is cosmetic churn, left (matches 7a discipline).
  - Zero-external "dead" TYPES from the scan are false positives — composed into used
    types/signatures within their file (`RenderPerformanceDebug`, the `NonRelease*`
    identity types, `LikeSyncStatus`, `WaveformSeekMode`, the `*Request` message types
    folded into the `ContentMessage` union, the key-confidence/resource-sampler/
    chrome-host return types). Kept.
  - GUARD honoured: predecode tiers + `key-confidence` thresholds untouched.
- **Deferred (cross-file dup, do NOT scatter):** private `clamp` is re-implemented in
  `shared/key-confidence.ts` (NaN→min) and `shared/tempo-adjust.ts` (no NaN guard) and
  as inline `clamp01` in waveform (6c carryover) — semantics differ, so a blind merge
  would change behaviour. Same shared-clamp/util consolidation already parked from 6c.

### 7a — routing & entry glue — DONE, commit `42bf4d6` (both builds clean)

- **Topology confirmed:** live shared dispatcher is `router-core.ts`
  (`dispatchSharedRuntimeMessage` + `registerRuntimeRouter`). Firefox wraps it directly;
  Chrome wraps `dispatchChromeRuntimeMessage` which overrides the analysis handlers
  (offscreen variants) + diagnostics and falls through to the shared dispatcher for the
  rest. `init.ts`'s `registerRouter` is just a param; both targets pass their own router.
- **Fix — deleted dead `src/background/router.ts` (105 lines).** No importer, not a
  webpack entry; it was the pre-refactor SUBSET of `router-core.ts` (same dispatch minus
  the 4 newer types: OPEN_BACKGROUND_TAB + the 3 resource-diagnostics). Superseded.
  Updated the two now-stale `architecture-rules.md` references (message-flow line +
  Directory Index) to point at `router-core.ts`. Both builds compile clean.
- **Coverage verified clean:** every router request type in the ContentMessage union is
  dispatched (Chrome `CLEAR_ANALYSIS_CACHE` correctly falls through to shared — the SW
  owns the persistence cache on Chrome). `PAUSE_LOCAL_PLAYBACK` / `PLAYBACK_SHORTCUT_COMMAND`
  are background→content PUSH messages handled in `content/playback-handoff.ts`, not router
  requests — no gap. `PING` is offscreen-host-internal.
- **Verified non-issues (no fix):** Chrome `handleAnalyzeKeyDebug`/`handleAnalyzeBpmPrototype`
  return "not-yet-wired" — intentional, in-code documented. `requestChromeAnalysisHost`
  single 120ms retry on the MV3 "Receiving end does not exist" race is a real, bounded,
  deterministic product dependency (offscreen-doc eviction) — allowed, not a speculative guard.
  Chrome analysis handlers dropping `sender` vs the shared `(message, sender)` signature is
  intentional (offscreen routes by url/cacheKey).
- **Left (cosmetic, low value):** `ensureChromeAnalysisHost` (offscreen-manager) and
  `RuntimeMessageDispatcher` (router-core) are exported but used only in-file — harmless,
  not trimmed (export reads as documented surface). Directory Index still lists `index.ts`
  as the bg entry (really `init.ts` + targets) — pre-existing doc drift, out of 7a blast radius.

## Remaining areas (not yet started)

- **Area 5 — Discover Controller & Origin Bridge:** `src/content/discover/
  controller.ts` (the big `initDiscoverController` closure; see AGENTS/architecture
  rules large-file guide), `controller-helpers.ts`, `origin-bridge/` (the injected
  page-context script that intercepts the native audio element + owns wishlist
  mutation POSTs), `runPlaylistAttempt()`, `syncFromDiscover()`. Note: discover
  `normalize.ts` still has its own `readTrackIdFromUrl` (3rd fork) — reconcile here.
- **Area 6 — UI, Glass & Debug Panel:** `src/ui/panel.ts`, `components/`,
  `debug-panel/`, `key-tuning/`, `styles/`. Liquid-glass on main (see memory
  `project_liquid_glass_branch`).
- **Area 7 — Background Infrastructure & Shared:** `src/background/index.ts`,
  `router.ts`/`router-core.ts`, `cache.ts`, worker-pool, `src/shared/*`,
  `src/utils/*`. Note router-core vs router duplication; worker-pool/concurrency.

## Reference

- Rules docs: `rules/{audio,bpm-analysis,metadata,playlist,architecture,
  debug-ui,build}-rules.md` plus `rules/wishlist-and-collection.md`. Read the relevant one
  before each area.
- Build: `npm run build` (Firefox → dist/firefox), `npm run build:chrome`
  (→ dist/chrome). Both must compile clean.
- Sanity check: user pastes the in-extension debugger "Copy All" dump (Alt+D) for
  the page type touched; verify the relevant signals, then commit.
