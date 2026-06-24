# Wishlist & Collection — Complete Reference

This is the **single source of truth** for how Bandcamp Deck builds a fan's **wishlist and
collection** (the read/sync path) and how it **changes** them with collect/uncollect (the
write/mutation path). It covers the like-state model, fan-id resolution, the fan-collection
pagination, the two background caches, the mutation gate/preflight, and the page-context bridge
that actually performs the POST.

It is written to be rebuildable from scratch. The **Current Design** sections describe the
best-known-working solution as of 2026-06-20; the guardrails in §2 and the rejected approaches
in §9 are the decisions that keep it correct.

> Scope: this is **like/wishlist/collection inventory + mutation**. *Playlist resolution,
> preload, and analysis-request routing* live in `rules/playlist-rules.md`. *Release
> metadata, Tralbum, custom-domain permissions, and Discover identity selection* live in
> `rules/metadata-rules.md`. The page-context **origin bridge** itself (audio + command
> transport) is also used by runtime audio — see `rules/audio-rules.md` §4.8.

---

## 1. The problem

Bandcamp exposes a fan's wishlist and collection only behind **authenticated APIs**, and the
"like" affordance (the heart) is a **collect/uncollect** action that the real Bandcamp page
performs from its own page JavaScript. The extension must solve two things at once:

1. **Build a complete local inventory** so it can colour like-state (unknown / disliked / liked /
   bought) for every album and track it shows — across the player page, Discover, fan-root, the
   feed, and recommendations — without hammering the API.
2. **Mutate that inventory** (heart on/off) from a content script that runs in the **isolated
   world** and therefore *cannot* read Bandcamp's page globals (the crumb token) or issue the
   POST with the page's own credentials/headers the way the site does.

Two hard constraints shape everything:

- **API rate limits.** The fan-collection endpoints return 429/403 under load; sync must pace
  itself, back off deterministically, and never wedge.
- **The content↔page-context boundary.** The CSRF **crumb** and a same-origin POST are only
  reliably available in the **page context**, so the mutation must be relayed through an injected
  page-context bridge. The content script prepares and gates the request; the bridge sends it.

---

## 2. The model (the contract)

### Definitions

- **Inventory** — eight sets held in `LikeInventorySets` (`likes/state.ts`):
  `{wishlist,collection} × {album,track} × {ids,urls}`. IDs are digit-normalized
  (`normalizeLikeId`); URLs are canonicalized (`toCanonicalLikeUrl` = `origin + pathname`,
  lowercased, trailing slashes stripped). Membership is matched by **id OR canonical url**, so a
  track known only by URL still resolves.
- **Wishlist** — items the fan has "liked" (the heart). Maps to like-state `liked`.
- **Collection** — items the fan **owns/bought**. Maps to like-state `bought`.
- **Like state lattice** (`state.ts toState`, rank in `inventory-utils.maxLikeState`):
  `bought` (in collection) > `liked` (in wishlist) > `disliked` > `unknown`. `disliked` is only
  emitted when inventory coverage is trustworthy (`allowDisliked`); otherwise an absent item is
  `unknown`, not `disliked`.
- **Album-derived track display** (`inventory-utils.applyAlbumDerivedTrackDisplay`): when a
  strict album identity is liked or bought, its tracks inherit that state for display (a bought
  album's tracks render bought; a liked album's tracks render at least liked).
- **Fan id** — the numeric id of the viewing fan; required for every API call.
- **Crumb** — Bandcamp's per-action CSRF token, endpoint-specific
  (`collect_item_cb` / `uncollect_item_cb`).
- **Endpoint coverage** — an endpoint is *complete* only when its sync status matches
  `ok:pages=<n>:complete` (`inventory-utils.endpointStatusIsComplete`). Partial coverage is
  usable but is **not** publishable to the shared cache.

### Identity is API-first and trust-gated

Like-identity for a track is only trusted when it comes from a `TralbumAPI` or `TralbumData`
source (`state.evaluateTrackLikeIdentityTrust` / `isTrustedPlaylistLikeSource`). A release-only
URL hint is **never** used to lock a track's like-identity, because the same custom-domain
release URL can map to a different band/album. This mirrors and depends on the Discover identity
rules in `rules/metadata-rules.md`. See also `[[project_album_like_identity]]` for why a
collected album can still show as not-collected (own-id extraction + API-only like identity).

### Non-negotiables

1. **Mutation goes through the page bridge only.** There is no active background mutation POST.
   Do not treat any background `TOGGLE_WISHLIST_ITEM`-style handler as the live path without
   re-checking `toggleWishlistItemPhase1StatusOnly()` (`likes/mutations.ts`).
2. **Deterministic pacing/backoff.** No random jitter anywhere (`inventory-utils.toBackoffMs`):
   a single client has no thundering herd to jitter against, and the defer-vs-sleep decision must
   be reproducible.
3. **Success is sticky.** After a successful, complete sync, do not re-fetch unless explicitly
   forced (one narrow Discover `reset-soft` exception). A resolved inventory must not flicker back
   to a loading state.
4. **Publish complete inventories only.** Page-local focused matches stay local; only a fully
   paginated inventory is written to the shared cache, so one surface can never overwrite the
   global inventory truth with a partial view.
5. **The persistent bought cache is merge-only.** It accumulates owned items and never evicts, so
   a collected album/track stays `bought` across reloads and offline. Do not add eviction.
6. **Synchronous in-flight guard for mutation.** A second rapid click on the same heart must be
   rejected *before any `await`* (see §5) — this is the fix for the double-fire collect+uncollect
   bug; do not move the in-flight increment after an await.
7. **No speculative retries or hidden fallback mutation paths.** Retry/pacing must stay
   deterministic and visible in the debug trace.

---

## 3. Architecture

`LikesStatusController` (`content/likes/inventory.ts`) is the content-side facade: it owns the
inventory sets, the sync state machine, view-state resolution, mutation deltas, and the debug
snapshot. It is one of only two classes in the codebase (see `architecture-rules.md`).

**Read / sync path:**

```
content (LikesStatusController.sync)
  → resolveViewerFanId (viewer-id.ts) ─ RESOLVE_FAN_ID ─→ handleResolveFanId (handlers/likes.ts)
  → hydrate persistent-bought cache ── GET_PERSISTENT_BOUGHT_LIKES_CACHE ─→ persistent-bought-likes-cache.ts
  → hydrate shared cache ──────────── GET_SHARED_LIKES_CACHE ───────────→ likes-cache.ts
  → syncEndpoint(wishlist) ‖ syncEndpoint(collection)
        ── FETCH_FANCOLLECTION_ITEMS ─→ handleFetchFancollectionItems ─→ POST /api/fancollection/1/<endpoint>
  → replaceEndpointData → publish shared + persistent-bought caches
```

**Write / mutation path:**

```
heart click → LikeMutationController.runToggle (mutation-controller.ts)
  → resolveLikeMutationPreflight (mutations.ts)   [fan-id, crumb, band-id, same-host]
  → evaluateLikeMutationGate (mutation-gate.ts)   [ordered block reasons]
  → toggleWishlistItemPhase1StatusOnly (mutations.ts)
  → requestLikesMutationViaBridge (origin-bridge/index.ts)
  → runLikesMutation (origin-bridge/script/section-a.ts, PAGE CONTEXT)
       → POST {origin}/collect_item_cb | /uncollect_item_cb
  → applyMutationDelta (optimistic local inventory update)
```

Two background caches back the read path: an **in-memory shared-likes cache** (per-fan, 30-min
TTL, complete snapshots only) and a **persistent bought-likes cache** (`chrome.storage`,
merge-only union).

---

## 4. Sync (the read path), mechanism by mechanism

### 4.1 Fan-id resolution

`resolveViewerFanId` (`viewer-id.ts`) tries, in order: the in-page window context strictly
(`Identities.current_fan_id`, `PageData.viewer_fan_id`), then the background `RESOLVE_FAN_ID`
message. `handleResolveFanId` (`handlers/likes.ts`) honours a `fanIdHint`, else fetches the
`bandcamp.com/` root HTML (credentialed) and extracts the viewer fan-id, else falls back to
`/api/fan/2/collection_summary`. Result is cached for 10 minutes with a single in-flight promise
so concurrent surfaces don't each resolve.

### 4.2 Sync eligibility & pacing

`shouldSkipSyncStart` enforces: a `SYNC_MIN_INTERVAL_MS` (60 s) floor between attempts; **resolved
is sticky** (a `success` state skips re-fetch unless `force`, except a Discover `reset-soft`
refresh); a faster `FAN_ID_RETRY_BACKOFF_MS` (1.2 s) retry only when the last failure was
`fan-id-unavailable`; and a `nextRetryTs` backoff window (bypassed for `reset-soft`). Rapid origin
jumps (Discover scrubbing) are burst-tracked (`RAPID_ORIGIN_JUMP_*`) and can trigger a 60 s
cooldown that suppresses sync entirely.

### 4.3 `sync()` → `runSync()`

`sync()` wraps `runSync()` in a `Promise.race` against a 45 s stall guard
(`SYNC_STALL_TIMEOUT_MS` via `waitForSyncStall`), tracks a monotonic `runSeq` so only the active
run can mutate terminal state, and on failure during a **silent** background run keeps the last
good `success` instead of surfacing an error.

`runSync()` order: resolve fan-id → **hydrate persistent-bought cache** → **hydrate shared
cache** → if coverage is already complete and the run is neither forced nor a focus-verify, return
`success` from cache → otherwise fetch both endpoints in parallel
(`syncEndpoint('wishlist_items')` and `syncEndpoint('collection_items')`), `replaceEndpointData`
on success, and publish caches when coverage is complete.

### 4.4 `syncEndpoint()` — paginated fan-collection fetch

Each endpoint paginates POSTs to `/api/fancollection/1/<endpoint>` via the
`FETCH_FANCOLLECTION_ITEMS` background message:

- **Seed token:** a synthetic far-future `older_than_token` (`buildSyntheticStartToken`) so the
  first page returns the newest items; subsequent pages follow `extractFanItemsPaging`.
- **Page size:** `LIKES_FANCOLLECTION_PAGE_SIZE` (1000), `PAGE_REQUEST_SPACING_MS` (220 ms)
  between pages.
- **Retry limit:** `ENDPOINT_DEFAULT_MAX_ATTEMPTS` (8), raised to
  `ENDPOINT_DEEP_COLLECTION_MAX_ATTEMPTS` (40) for the collection endpoint in root/feed contexts
  (large libraries need to fully exhaust pagination).
- **Backoff:** deterministic `toBackoffMs` (honours server `retry-after`); a long wait that would
  exceed the remaining sync budget is **deferred** (`shouldDeferLongRetry`) rather than slept, so
  the run ends cleanly and resumes later.
- **Retryable** = 429 / 5xx / network error; anything else fails fast.
- Parsing: `inventory-utils.applyPayloadToSnapshot` walks `items` and `item_lookup`, inferring
  item type and id/urls (`inferItemType`, `collectItemUrls`). Status is
  `ok:pages=<n>:complete` only when paging reports no more items.

### 4.5 Background rate-limit guard

`handleFetchFancollectionItems` (`handlers/likes.ts`) adds a server-friendly guard independent of
the content pacing: a per-endpoint 500 ms min interval, a global backoff-until window, 429/403 →
2-min backoff, 5xx → 30-s backoff, all honouring `retry-after`. It validates the endpoint, fan-id,
and `older_than_token`, and clamps `count`.

### 4.6 Caches

- **Shared likes cache** (`background/likes-cache.ts`): in-memory `Map` per fan-id, 30-min TTL
  (`SHARED_LIKES_CACHE_MAX_AGE_MS`), newest-wins, **complete snapshots only** (`publishSharedCache`
  guards on `hasCompleteInventoryCoverage`). Lets a second tab/surface hydrate the full inventory
  instantly.
- **Persistent bought-likes cache** (`background/persistent-bought-likes-cache.ts`): `chrome.storage`
  keyed `persistent_bought_likes_cache_v1`, **merge-only union** of collection ids/urls, flushed on
  write. This is what makes ownership survive restarts and brief offline use (non-negotiable #5).

---

## 5. Mutation (the write path), mechanism by mechanism

### 5.1 `LikeMutationController.runToggle`

1. Compute the action (`resolveAction`: track honours an explicit liked flag; otherwise toggle
   from current state) and a per-target mutation key.
2. **Synchronous in-flight reject** (non-negotiable #6): if a mutation is already in flight, bail
   with `blocked_in_flight` *before* any `await`; only then increment the in-flight count.
3. Run `resolveLikeMutationPreflight`, record inputs to the debug snapshot, then
   `evaluateLikeMutationGate`. If either blocks, surface the reason code and stop.
4. Dispatch via `toggleWishlistItemPhase1StatusOnly`, record the signature
   (`ep=… origin=… via=… status=… reason=…`), and apply the optimistic local delta
   (`applyMutationDelta`) so the heart flips immediately.
5. A per-key cooldown (~1 s) prevents rapid re-toggling.

**Optimistic write is protected, not immediately re-synced.** `applyMutationDelta` stamps
`lastMutationTs`, and `shouldRunDeepSync` then **suppresses** deep sync for
`MUTATION_DEEP_SYNC_SUPPRESS_MS` (= `SHARED_LIKES_CACHE_MAX_AGE_MS`, 30 min). This is deliberate: a
fresh write would otherwise be clobbered by a still-stale cached/eager read. The local delta is the
truth until that window elapses or a `force` sync is requested; there is no per-item re-fetch.

### 5.2 The gate (`mutation-gate.ts`)

`evaluateLikeMutationGate` blocks in this fixed order: recommendations context →
`writes-disabled` → in-flight → cooldown → missing identity → missing item-id → missing fan-id →
missing crumb → bought-state blocks (can't un-buy) → `blocked_track_uncollect_album_liked` →
sync-unresolved. Reason codes are stable strings surfaced in the debug panel.

### 5.3 Preflight (`mutations.ts`)

`resolveLikeMutationPreflight` resolves everything the POST needs:

- **Fan id** via `resolveViewerFanId`.
- **Crumb** via `readMutationCrumb`: window `_crumbs[endpoint]`, `gCrumb`, `TralbumData`, the
  bridge's latest page globals, then the DOM; if still missing, a credentialed fetch of the site
  root HTML (`readRootCrumb`, cached 5 min) extracts the endpoint crumb.
- **Band id** (`readBandId`) and the canonical **page url**.
- **Same-host enforcement:** cross-host mutation is blocked unless the page is `bandcamp.com` or
  the runtime like-context is a non-`release-pages` family (feed/recommendations/fan-root/Discover
  all post to `bandcamp.com`). This keeps custom-domain release mutations honest.

### 5.4 Transport (`origin-bridge/script/section-a.ts runLikesMutation`, page context)

The bridge runs in the **page context** and does the actual work: a form-encoded POST to
`{origin}/collect_item_cb` or `/uncollect_item_cb` with `credentials: include`,
`x-requested-with: XMLHttpRequest`, the resolved crumb, and (for custom domains posting to
`bandcamp.com`) a `custom_domain_host` param. On an `invalid_crumb` response it retries **once**
with the server-supplied fresh crumb. It is the **only** mutation transport;
`toggleWishlistItemPhase1StatusOnly` reaches it through `requestLikesMutationViaBridge`
(`origin-bridge/index.ts`) and reports `transport: 'page-bridge'`.

---

## 6. Constants (the knobs)

Content-side constants live in `likes/inventory.ts`, shared budgets in `shared/constants.ts`,
background guard constants in `handlers/likes.ts`.

| Constant | Value | Where | Role |
|---|---|---|---|
| `SYNC_MIN_INTERVAL_MS` | 60 s | inventory | min spacing between sync attempts |
| `ERROR_BACKOFF_MS` | 30 s | inventory | backoff after a failed sync |
| `FAN_ID_RETRY_BACKOFF_MS` | 1.2 s | inventory | fast retry when fan-id was unavailable |
| `ENDPOINT_DEFAULT_MAX_ATTEMPTS` | 8 | inventory | per-endpoint retry cap |
| `ENDPOINT_DEEP_COLLECTION_MAX_ATTEMPTS` | 40 | inventory | collection cap in root/feed contexts |
| `PAGE_REQUEST_SPACING_MS` | 220 ms | inventory | spacing between pagination pages |
| `SYNC_STALL_TIMEOUT_MS` | 45 s | inventory | stall guard on a run |
| `RAPID_ORIGIN_JUMP_*` | 4 / 5 s / 60 s | inventory | burst limit / window / cooldown |
| `SHARED_LIKES_CACHE_MAX_AGE_MS` | 30 min | constants | shared-cache TTL + staleness trigger |
| `LIKES_FANCOLLECTION_PAGE_SIZE` | 1000 | constants | items per page |
| `LIKES_FANCOLLECTION_FETCH_TIMEOUT_MS` | 15 s | constants | per-page fetch timeout |
| `COLLECTION_SUMMARY_API` | `/api/fan/2/collection_summary` | constants | fan-id fallback endpoint |
| `FAN_ITEMS_MIN_INTERVAL_MS` | 500 ms | handlers/likes | server-friendly per-endpoint spacing |
| `FAN_ITEMS_RATE_BACKOFF_MS` | 2 min | handlers/likes | 429/403 backoff |
| `FAN_ITEMS_ERROR_BACKOFF_MS` | 30 s | handlers/likes | 5xx/network backoff |
| viewer-fan-id TTL | 10 min | viewer-id | fan-id cache |
| root-crumb TTL | 5 min | mutations | mutation crumb cache |
| mutation cooldown | ~1 s | mutation-controller | per-heart re-toggle guard |
| `MUTATION_DEEP_SYNC_SUPPRESS_MS` | 30 min (= shared TTL) | inventory | suppress deep sync after a write so the optimistic delta isn't clobbered |

---

## 7. Debug signatures (prove each path ran)

The debug panel is always live (info menu or **Alt+D**); the likes area carries the inventory and
mutation traces. The anonymized export omits fan/account identity (see `debugger-rules.md`).

**Sync process events** (`inventory.pushProcessEvent`): `sync.start` (with `trigger`/`ageMs`) →
`fan.id.resolved|missing` → `bought.cache.hit` / `shared.cache.hit` → `endpoint.page.<endpoint>`
(`pages=…`) → `endpoint.summary` (`w=<status>;c=<status>`) → `sync.success`
(`reason=inventory-ready|inventory-partial|shared-cache`) or `sync.failed`. A cache hydrate shows
`shared.cache.apply` / `bought.cache.apply`.

**Mutation process events** (`mutation-debug.ts`): `click.received` → `gate.inputs`
(`item=… fan=… crumb=… source=…`) → either `gate.blocked` (`<key>:<reasonCode>`) or
`request.dispatched` → `request.succeeded` / `request.failed` → `mutation.signature`
(`ep=… origin=… via=page-bridge status=… reason=…`).

Use these to distinguish *blocked* (gate) from *failed* (transport), and to confirm a sync hit
cache vs fetched.

---

## 8. Verification

This doc is docs-only — review the diff. For **code** changes in this area:

- `npx tsc --noEmit`, `npm run check:module-lines`, `git diff --check`.
- Both production builds (`npm run build` + `npm run build:chrome`): the likes path is shared.
- Manual: like/unlike an **album** and a **track** on a player page and on Discover; confirm the
  heart flips optimistically and the state survives a reload (shared cache) and that an owned
  album stays `bought` (persistent cache). Confirm a forced rate-limit (429) backs off and the
  sync recovers rather than wedging. Confirm a custom-domain release mutates against
  `bandcamp.com` with the `custom_domain_host` param.

None of these is "done" until the intended browser is verified and the other is checked for
regression (`build-rules.md`).

---

## 9. Rejected approaches & guardrails — do not revive without contradicting evidence

- **Background mutation POST** as the live path — not used. The crumb + same-origin credentials
  are only reliable in the page context, so the bridge owns the POST. Re-check
  `toggleWishlistItemPhase1StatusOnly()` before assuming otherwise.
- **Random jitter in backoff** — rejected; pacing must be reproducible and the defer-vs-sleep
  decision compares a deterministic wait against the remaining budget.
- **Publishing partial inventories to the shared cache** — rejected; a partial view could
  overwrite a complete one on another surface. Only complete coverage publishes.
- **Evicting the persistent bought cache** — rejected; ownership must persist (offline/restart).
- **Moving the in-flight increment after an `await`** — rejected; it reintroduces the double-fire
  collect+uncollect race. The guard must be synchronous.
- **Locking like-identity from a release-only URL hint** — rejected; the same custom-domain URL
  can map to a different release. Trust only `TralbumAPI`/`TralbumData` track identity.
- **Forcing a fresh sync right after a write** — rejected; an eager re-read can still see the
  pre-write cache and clobber the new state. The write is held optimistically and deep sync is
  suppressed for 30 min (§5.1). Do not replace this with an immediate re-sync.

---

## 10. Open items / future work

- The optimistic `applyMutationDelta` is held as truth and deep sync is suppressed for 30 min
  (§5.1); there is no per-item re-fetch, so a (rare) reported-ok-but-actually-failed write would
  self-heal only after that window or on a `force` sync.
- Deep collection sync for very large libraries can hit the 40-attempt cap under sustained
  rate-limiting and finish *partial*; it recovers on a later run but the partial window is not
  surfaced as a distinct user-facing state beyond the debug `inventory-partial` reason.

---

## 11. Files

- `src/content/likes/inventory.ts` — `LikesStatusController`: sync state machine, eligibility,
  pagination orchestration, caches hydrate/publish, view-state, mutation deltas, debug snapshot.
- `src/content/likes/state.ts` — inventory sets, identity/url canonicalization, membership →
  like-state, serialization, album-derived display inputs.
- `src/content/likes/inventory-utils.ts` — endpoint payload parsing, snapshot apply/replace,
  deterministic backoff, synthetic seed token, like-state rank, album-derived track display.
- `src/content/likes/inventory-helpers.ts` — focus keys, debug formatting, track-state summaries.
- `src/content/likes/viewer-id.ts` — viewer fan-id resolution + cache.
- `src/content/likes/mutations.ts` — preflight (fan-id/crumb/band-id/same-host), bridge dispatch.
- `src/content/likes/mutation-controller.ts` — `LikeMutationController` (in-flight guard,
  cooldown, gate, dispatch, optimistic delta).
- `src/content/likes/mutation-gate.ts` — ordered block-reason gate.
- `src/content/likes/mutation-debug.ts` / `toggle-helpers.ts` — mutation debug + helpers.
- `src/background/handlers/likes.ts` — `RESOLVE_FAN_ID`, `FETCH_FANCOLLECTION_ITEMS`, shared +
  persistent cache get/set; background rate-limit guard.
- `src/background/likes-cache.ts` — in-memory shared-likes cache (complete-only, 30-min).
- `src/background/persistent-bought-likes-cache.ts` — `chrome.storage` merge-only bought cache.
- `src/content/discover/origin-bridge/index.ts` — `requestLikesMutationViaBridge`,
  `getLatestPageGlobals`.
- `src/content/discover/origin-bridge/script/section-a.ts` — page-context `runLikesMutation` (the
  actual POST transport).
- `src/shared/constants.ts` — the budget/TTL knobs; `src/shared/types.ts` — snapshot/inventory
  types and the `ContentMessage` variants.
