# Bandcamp Playlists — Feature Plan & Progress Log

Living document for the **Bandcamp Playlists** feature (adding albums/tracks to the
fan's own Bandcamp playlists from inside Bandcamp Deck). It holds the agreed plan, the
decisions behind it, and a running log of what we built and what failed.

- API reference: [`bandcamp_playlist_api.md`](bandcamp_playlist_api.md)
- Status: **PAUSED (2026-06-25)** — spike complete, no code written. **Blocker:** adding/removing
  playlist tracks is **app-only (OAuth bearer)**; the web has no such endpoint (proven from
  Bandcamp's own client source, see §10). Only the *read* path is web-feasible today.
- To resume: pick up at the decision fork in §10 (capture app OAuth via Proxyman & assess, or
  ship the read-only slice). Everything needed to restart is in §5 (spike) and §10 (findings).
- Last updated: 2026-06-25

---

## 1. Goal

Let the user add music to their own Bandcamp playlists without leaving the player:

- A `+` button in the **player header** → adds the whole **album**.
- A `+` button in each **playlist track row** → adds a single **track**.
- Clicking `+` opens a small popup listing the user's playlists plus a
  "Create new playlist" option.

---

## 2. MVP scope (agreed)

**First slice = track add only, add-only popup.**

- `+` in each playlist track row.
- Popup: list the fan's playlists + "Create new playlist" (with a public/private toggle).
- Clicking a playlist **adds** the current track; creating one makes it and adds the track.
- **Not** in the MVP: album header `+`, remove-from-playlist, "already-in-playlist"
  decoration, incremental `newest_token` sync, persistent cross-reload cache.

### Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| First slice | Track add only | API-confirmed path (`item_type:"t"`); lowest risk. |
| Popup behavior | Add-only | Smallest correct build; no read-decoration needed yet. |
| New-playlist privacy | Public/private toggle on the create row | `is_private` is a real two-way field; don't hard-code. |
| Existing-playlist privacy | Preserve current `is_private` on every save | Adding a track must never flip a playlist public/private. |
| When to fetch playlists | Eager, once during player `init()` | Popup opens instantly; one background call per page load. |
| Album add (Phase 2) | Expand album → add all its track IDs | Removes dependence on the unconfirmed album `item_type`. |
| Album add shape | One batched read-modify-write save (append all tracks, post once) | Deterministic; avoids hammering the full-replace endpoint. |

---

## 3. Key risks / unknowns

The API doc was reverse-engineered from the **Android** app. Two things must be confirmed
against the **web** endpoint before committing a transport (see Step 0):

1. **Does `/api/playlist/1/save` need a CSRF crumb on the web?**
   Android uses bearer+cookies with no crumb. The website's collect/uncollect *does* need a
   crumb. This decides the transport (background fetch vs. page-bridge).
2. **Does `/api/playlist/1/fetch` need a fan-id in the body?** Probably session-based, but
   confirm.

Album `item_type` uncertainty is **no longer a risk** — album add is done by expanding to
track IDs.

---

## 4. Transport decision (depends on Step 0)

The codebase already has both patterns:

- **Background credentialed fetch** — used for wishlist/collection *reads*
  (`FETCH_FANCOLLECTION_ITEMS` in `src/background/handlers/likes.ts`). Simple.
- **Page-context bridge** — used for collect/uncollect *writes* because they need the crumb
  (`src/content/likes/mutations.ts` → `src/content/discover/origin-bridge/`).

**Default plan: background fetch** for both fetch and save (expected, since the API doc shows
no crumb). **Fallback: page-bridge** for save if Step 0 shows a crumb is required.

---

## 5. Step 0 — Spike (run these first)

Run in the **devtools console of a logged-in `bandcamp.com` tab** (not curl — see the log
entry below for why). Devtools supports top-level `await`, so paste each block as-is.

**Safety:** `/api/playlist/1/save` is a **write** endpoint with a **full-replace** model — a
wrong `items` array silently wipes a playlist. Only ever mutate the throwaway test playlist
created in step B. Clean it up afterwards from the Bandcamp UI (the API doc documents no
delete-playlist endpoint).

```js
// Shared request helper — same shape our extension will use.
const PL = (path, body) =>
  fetch("https://bandcamp.com" + path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, ok: r.ok, body: await r.json().catch(() => null) }));
```

**A. Fetch all playlists** — confirms the read shape and whether a fan-id is needed in the body.
```js
const all = await PL("/api/playlist/1/fetch", { newer_than_token: "0:0" });
console.log("FETCH", all.status, all.body);
// Record: does body.items exist? value of newest_token / sync_date? any auth error?
```

**B. Create a throwaway test playlist** — this is also the **crumb test**.
```js
const created = await PL("/api/playlist/1/save", {
  playlist: { title: "DECK TEST — delete me", is_private: true, items: [] }
});
console.log("CREATE", created.status, created.body);
// INTERPRETATION:
//   success + a returned id        → NO crumb needed → background-fetch transport is viable.
//   403 / error mentioning crumb   → crumb REQUIRED  → save must go through the page-bridge.
```

**C. Re-fetch to grab the test playlist + pick a track id.**
```js
const after = await PL("/api/playlist/1/fetch", { newer_than_token: "0:0" });
const test = after.body.items.find((p) => p.title === "DECK TEST — delete me");
console.log("TEST PLAYLIST", test);

// A track id: on a track page → window.TralbumData.trackinfo[0].track_id (or .id);
// on an album page each trackinfo entry has one; or reuse an item_id from any
// existing playlist in after.body.items.
const trackId = /* paste a numeric track id */ 0;
```

**D. Add the track (full-replace)** — preserves existing items, title, and privacy.
```js
const items = [
  ...test.items.map(({ id, item_id, item_type }) => ({ id, item_id, item_type })),
  { item_id: trackId, item_type: "t" }
];
const saved = await PL("/api/playlist/1/save", {
  playlist: { id: test.id, title: test.title, is_private: test.is_private, items }
});
console.log("ADD", saved.status, saved.body);
```

**E. Confirm the track landed.**
```js
const confirm = await PL("/api/playlist/1/fetch", { newer_than_token: "0:0" });
console.log("CONFIRM", confirm.body.items.find((p) => p.id === test.id));
// Expect the new track present in .items. Then delete the test playlist via the Bandcamp UI.
```

**What to record in §9 / the log:** the four status codes; whether step B returned a crumb
error (the transport decision); the response body shape of `save` (does it echo back the saved
playlist with server-assigned `id`s?); and the real behavior of `newest_token` (the doc's
example shows `""`, which is suspicious for incremental sync).

---

## 6. Architecture (assuming background-fetch path)

> Naming note: `rules/playlist-rules.md` already exists and means *Deck's on-page tracklist
> resolution/sorting* — a different thing. This feature uses the name **`userplaylists`** in
> code and will be documented in a new `rules/user-playlists-rules.md`.

**Types** — `src/shared/types.ts`
- `BandcampPlaylist { id, title, isPrivate, items }`, `PlaylistApiItem { id?, itemId, itemType }`.
- New `ContentMessage` variants: `FETCH_USER_PLAYLISTS`, `SAVE_USER_PLAYLIST`.

**Background** — new `src/background/handlers/userplaylists.ts`
- `handleFetchUserPlaylists`, `handleSaveUserPlaylist`.
- Register in `src/background/router-core.ts` (+ chrome/firefox router wrappers).
- Reuse likes-handler discipline: min interval, deterministic backoff, no jitter, no
  speculative retries.

**Content controller** — new `src/content/userplaylists/controller.ts`
- Closure factory (only `LikesStatusController`/`PlayerState` are classes).
- In-memory cache of the fan's playlists for the page session.
- `ensureLoaded()`, `addTrackToPlaylist(id, trackId)`, `createPlaylistWithTrack(title, isPrivate, trackId)`.
- **Full-replace contract**: re-fetch current items right before a save so we never clobber a
  concurrent change; then optimistically update the local cache.
- **Synchronous in-flight guard** so a double-click can't double-add (same rule as the
  mutation controller).

**UI**
- New `src/ui/components/playlist-add-menu.ts` — the popup (playlist list + inline "Create
  new" with public/private toggle; outside-click/Esc to close; positioned to the trigger; own
  `bc-` classes, host page treated as hostile).
- `src/ui/components/playlist-view.ts` — add a `+` cell per row (`bc-pl-add`) and the matching
  header column so the CSS grid stays aligned; new `onAddTrackToPlaylist(index)` handler.
- `src/ui/panel.ts` — wire the handler to open the menu / call the controller.
- `src/content/player/index.ts` — construct the controller, eager-fetch on init, pass handlers.
- New `src/ui/styles/playlist-add-menu.ts` + cell styling (extend `playlist.ts` for the grid column).

**Debug** — first-class, wired before the feature emits anything (see §7, Step 2).
- **New named area "User Playlists"** in `SECTION_ORDER`/`SECTION_TITLES`
  (`src/shared/debug-trace.ts`) — the single source of truth for areas. A dedicated area is
  justified (not folded into the existing "Likes" or "Playlist & Preload" areas) because this
  is a separate fetch/save lifecycle with its own failure modes; keep it **minimal** per the
  debugger "simplify first" rule — a few targeted lines, not broad logging.
- **Process events mirror the likes debug signatures** (`rules/wishlist-and-collection.md` §7):
  `playlists.fetch.start` → `playlists.fetch.ok` (`count=…`) / `playlists.fetch.failed`
  (`status=…`); `playlists.add.start` (`pl=… track=…`) → `playlists.save.dispatched` →
  `playlists.save.ok` / `playlists.save.failed`; `playlists.create.*`. These are what we ask
  the user to Copy when a save misbehaves.
- **Transport** lines (the crumb/page-bridge path, if Step 0 forces it) route into the existing
  **"Transport & Bridge"** area, consistent with the mutation bridge.
- **Anonymization:** the area MUST NOT print fan/account id or any auth token. Playlist ids and
  the operational counts are fine; treat playlist **titles** as redactable in the anonymized
  export (they can be user-identifying) — confirm against the export filter when wired.

---

## 7. Build order (each step independently verifiable)

1. **Spike** → confirm endpoints + crumb need; lock transport.
2. **Debugger first** → add the "User Playlists" area to `src/shared/debug-trace.ts` and the
   trace plumbing (a small `pushProcessEvent`-style emitter), so every step below reports into
   the always-live panel from the start. Nothing to trace yet — just the area + emitter.
3. **Types + background handlers + router wiring** → verify fetch/save in isolation, watching
   the new debug area for `playlists.fetch.*` / `playlists.save.*`.
4. **Content controller** → fetch, cache, add, create (each emitting its debug events).
5. **`+` cell + popup component + panel wiring + styles.**
6. **Verify**: `npx tsc --noEmit`, `npm run check:module-lines`, `git diff --check`, then both
   builds (`npm run build` + `npm run build:chrome` — shared content path), then manual
   add/create confirmed on bandcamp.com **and** in the debug panel (Copy "User Playlists").

### Phase 2 (after MVP)
- Header `+` (album add) — thin wrapper: expand the on-page album tracklist to track IDs,
  one batched full-replace save.

### Later / out of scope
- Remove-from-playlist, "already-in-playlist" decoration, `newest_token` incremental sync,
  persistent cross-reload cache.

---

## 8. Verification checklist (per repo rules)

- [ ] `npx tsc --noEmit`
- [ ] `npm run check:module-lines`
- [ ] `git diff --check`
- [ ] `npm run build` (Firefox)
- [ ] `npm run build:chrome` (Chrome)
- [ ] Manual: open a player page → track `+` → see playlists → add to one → create new →
      confirm the track appears on bandcamp.com.
- [ ] Debug: the "User Playlists" area shows `playlists.fetch.*` on load and
      `playlists.add/create/save.*` on action; anonymized export hides fan id / tokens (and
      playlist titles).

---

## 9. Progress log

Append newest entries at the top. Record what was done, the result, and anything that failed
(with the exact error / debug signature).

### 2026-06-25 — DECISION: pause the feature
- Spike conclusively shows playlist *content* writes (add/remove/create) are **app-only**
  (OAuth bearer); the web client has no such endpoint (52/52 endpoint sweep + proof-of-absence
  from Bandcamp's own JS — see §10 Failures & gotchas).
- The **read** path is fully usable today (`/api/fan_collection/1/playlists`, cookie-only).
- User chose to **pause** rather than (a) reverse-engineer the app OAuth via Proxyman, or
  (b) ship a read-only slice. No code written; this document is the complete record.
- **Resume options preserved** in §10: capture-and-assess the app OAuth, or build read-only.

### 2026-06-24 — Endpoint pivot: web uses `/api/fan_collection/1/*`, not `/api/playlist/1/*`
- The API doc's `/api/playlist/1/{fetch,save}` are the **Android app** endpoints — bearer-gated,
  reject cookie-only web calls with `Endpoints::AccessError`.
- The **website** reads playlists via `POST https://bandcamp.com/api/fan_collection/1/playlists`
  — **same-origin, cookie-auth, no `Authorization` header**. This is the path our extension can
  use. (Captured from the native `bandcamp.com/<user>/playlists` page via Network tab.)
- **READ PATH CONFIRMED (cookie-only, no crumb, HTTP 200):**
  `POST /api/fan_collection/1/playlists`
  body `{ "page_fan_id": <fanId>, "page_size": 20, "query": "" }`
  → `{ items: [...], nextCursor, totalCount }`. Each playlist item:
  `{ itemId (playlist id), itemUrl, creatorId, isPrivate, description, imageId, imageState,
  isFeatured, modDate, title, attribution }` plus `tracksSummary: {totalCount, totalDuration}`.
  Pagination via `nextCursor` + `page_size`; `query` enables search. **Tracks are NOT embedded**
  — only `tracksSummary`. So a per-playlist tracks fetch is needed (endpoint TBD).
- **Still to capture:** (1) the per-playlist **tracks read** endpoint (open a playlist, capture
  XHR); (2) the **write** endpoint(s) for create / add-track — and crucially whether the web
  write is **full-replace** (app model) or **incremental add** (if incremental, we may not need
  the full tracks list to add).
- The API doc (`bandcamp_playlist_api.md`) describes the app API; treat it as *shape* guidance
  only — the web endpoints differ. Update it once the web write endpoints are confirmed.

### 2026-06-24 — Spike approach: console over curl
- Decided to run Step 0 as console `fetch()` on a logged-in bandcamp.com tab, **not curl**.
- Why: the API doc's `Authorization: Bearer` path is the **Android** auth model. curl-with-bearer
  tests a different auth flow than the extension ships on, so it can't answer the one question
  that drives the build — *does the web `save` endpoint need a crumb?* A credentialed console
  fetch runs in the exact context our code uses and sends cookies automatically (no token/cookie
  extraction needed), so it's both more faithful and less setup.
- Added the ready-to-paste snippet sequence as §5.

### 2026-06-24 — Planning
- Read `AGENTS.md`, `bandcamp_playlist_api.md`, and the closest analog
  (`rules/wishlist-and-collection.md`, plus `ui-rules`, `architecture-rules`,
  `metadata-rules`, `playlist-rules`).
- Confirmed the like/wishlist system is the template (inventory read + mutation write).
- Agreed MVP scope and the decisions in §2. No code written.
- **Next:** Step 0 spike to confirm web-endpoint behavior (crumb? fan-id?).

---

## 10. Failures & gotchas (running list)

Record dead-ends here so we don't repeat them.

- **2026-06-24 — WRITE is app-only / OAuth-gated (MAJOR BLOCKER for the core feature).**
  Adding/removing/creating playlist items is **not available on the Bandcamp website at all**
  (only the Android app) — this was a motivation for the extension. The app writes via
  `/api/playlist/1/save`, which is **OAuth-bearer-gated** (the `playlist` API family is "app"
  access; the `fan_collection` family is "fan/cookie" access). The browser session has cookies
  but **no bearer token**, so writes can't be made the way reads can. **The read path is fully
  usable; the write path needs an OAuth token the extension does not currently have.** Direction
  decision pending (web→app token exchange vs. capturing the app OAuth flow vs. read-only).
  - **Web→app token probe (chosen direction):** no OAuth/bearer/access token exists anywhere in
    the web session — checked page-data blob, `window` globals, `localStorage`/`sessionStorage`.
    Only CSRF crumbs (`gCrumb`, `_crumbs`, `Crumb`) are present.
  - **Session+crumb on the app endpoint also fails:** `/api/playlist/1/fetch` with cookies +
    `crumb: gCrumb` + `X-Requested-With` still returns `AccessError`. App endpoints require the
    bearer, full stop. The only web→app artifact is the signed `redirect_to_app?...&sig=...`
    deep-link, whose token-exchange endpoint is not visible from the web → discovering it (or the
    app's `oauth_login` client creds) needs an Android/Proxyman capture.

- **2026-06-24 — LEAD: web playlist writes exist via `_web` endpoints (cookie+crumb).**
  `window._crumbs` includes **`api/playlist/1/set_visibility_web`** — a `_web` variant of the
  playlist API that authenticates with **session cookie + CSRF crumb** (no bearer). This proves
  the bearer-gated `/api/playlist/1/save` (app) has web siblings the extension *can* call.
  Likely siblings to probe: `create_web`, `add_item_web`/`add_items_web`, `remove_item_web`,
  `edit_web`. Plan: (1) capture the real `set_visibility_web` request from the web UI (privacy
  toggle) to learn the exact convention — endpoint path, body params, and **where the crumb
  goes** (body / query / header); (2) extrapolate that convention to probe the sibling write
  endpoints, testing only against a throwaway playlist. **This may make the full feature feasible
  cookie-only, no OAuth.** Full `_crumbs` (28) had no `*_cb`/`_web` for add/remove (no web UI),
  so those crumbs aren't preloaded here — but the endpoints may still exist server-side.

- **2026-06-24 — CONFIRMED `_web` write convention (captured from the privacy toggle).**
  `POST https://bandcamp.com/api/playlist/1/set_visibility_web`, `Content-Type: application/json`,
  body `{"playlist_id":<id>,"is_private":<bool>}`. **Auth = session cookie + per-endpoint crumb
  sent as the header `X-BC-Crumb`**, value format `|<endpoint_path>|<unix_ts>|<base64 sig>=`
  (the endpoint path is embedded in the crumb, so the server binds each crumb to its endpoint —
  a crumb for one `_web` endpoint will NOT validate for another). The crumb value comes from
  `window._crumbs["api/playlist/1/set_visibility_web"]`. No bearer, no `X-Requested-With` needed.
  **Open question:** to call `create_web`/`add_item_web`/etc. we need *their* crumbs, which are
  only preloaded into `window._crumbs` on a page whose JS declares those actions. Next: dump
  `_crumbs` on the **playlist owner page** (`/lani_d/playlist/<name>`) to see which playlist
  `_web` crumbs that page exposes.

- **2026-06-24 — Guessed `_web` write endpoints all 404 (`UnknownEndpointError`).**
  Probed `create_web, add_item_web, add_items_web, remove_item_web, edit_web, save_web,
  delete_web, fetch_web` under `api/playlist/1/` (cookie + mismatched crumb, empty body) — all
  **HTTP 404 `Endpoints::UnknownEndpointError`** (not `AccessError`), i.e. those names don't
  exist. Only `set_visibility_web` is confirmed. Note: the individual-playlist page
  `/lani_d/playlist/<name>` is a separate **"playlist" SPA** with no legacy `window._crumbs`;
  the listing page `/lani_d/playlists` is the classic page that carries `_crumbs`. Next: broader
  name sweep across `playlist` + `fan_collection` families; any non-404 = real endpoint. If the
  sweep is all-404, web add/remove genuinely doesn't exist → core write needs the app bearer.

- **2026-06-24 — CONCLUSION: no web write for playlist contents (52/52 candidates 404).**
  Broad sweep of 26 candidate names × {`api/playlist/1/`, `api/fan_collection/1/`} = 52 →
  **all HTTP 404 `UnknownEndpointError`**. Combined with the user's confirmation that the
  Bandcamp website cannot add/remove playlist tracks, this is definitive: the only web playlist
  write is `set_visibility_web`. **Adding/removing/creating playlist items requires the app's
  OAuth bearer token**, which the browser session cannot produce (no token present; cookies +
  crumb rejected with `AccessError`; no web→app token exchange found). Web-side options are
  exhausted. Remaining forks: (1) capture the Android app's OAuth + write via Proxyman and
  replicate it in the extension — works but grey-area (ToS), fragile, requires storing/refreshing
  a per-user bearer and the app's OAuth client creds; (2) ship **read-only** (list playlists /
  show which playlist contains a track — the read path works today) and defer writes; (3) pause
  the feature. **Decision pending.**

- **2026-06-24 — PROOF-OF-ABSENCE from Bandcamp's own JS (not guessing).**
  Concatenated all Bandcamp/bcbits playlist-SPA bundles (`s4.bcbits.com/vite/playlist/client/...`,
  ~1 MB, 8 scripts, 0 fetch failures) and token-scanned. Sanity check passed (`set_visibility`
  present → we read the right code). The **only** `_web` action tokens in the entire playlist
  frontend are `player_data_web`, `set_visibility_web`, `weekly_mobile_web`. The substrings
  `add_item` / `remove_item` appear **nowhere**. (Full endpoint paths are built dynamically, e.g.
  `"api/playlist/1/" + action`, which is why literal-path regexes returned nothing — the
  token-level scan is the reliable method.) **Definitive: the web client has no add/remove/create
  playlist-contents capability.** Confirms the 52/52 endpoint sweep was not a naming miss.

### Summary of what works vs. doesn't (as of spike end)
| Operation | Web (cookie/crumb) | Notes |
|---|---|---|
| List playlists | ✅ `POST /api/fan_collection/1/playlists` `{page_fan_id,page_size,query}` | cookie-only, no crumb |
| Playlist tracks | ❔ not captured | likely a `fan_collection` read; TBD |
| Set visibility | ✅ `POST /api/playlist/1/set_visibility_web` | cookie + `X-BC-Crumb` header |
| Create playlist | ❌ no web endpoint | app/oauth only |
| Add track | ❌ no web endpoint | app/oauth only — **the core feature** |
| Remove track | ❌ no web endpoint | app/oauth only |
- **2026-06-24 — `/api/playlist/1/fetch` with cookie-only auth → `AccessError` (BLOCKER).**
  `POST /api/playlist/1/fetch` `{newer_than_token:"0:0"}`, `credentials:"include"`, from a
  logged-in `bandcamp.com` console returns **HTTP 200** but body
  `{__api_special__:"exception", error_type:"Endpoints::AccessError"}`. So cookies alone are
  **not** enough for these endpoints — contradicts the API doc's "just use credentials:include."
  Contrast: `/api/fancollection/1/*` (likes) *does* work cookie-only. Hypotheses to test:
  (a) needs `X-Requested-With: XMLHttpRequest`; (b) needs the mobile `Authorization: Bearer`
  token (these may be app-only endpoints); (c) needs a `client_id` cookie the web session lacks;
  (d) the **website** uses a *different* endpoint entirely — capture the real request from the
  native Bandcamp playlist UI via the Network tab. **Transport decision is on hold until this
  resolves.**
