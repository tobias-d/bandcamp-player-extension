# Runtime Audio — Complete Reference

This is the **single source of truth** for Bandcamp Deck's runtime audio path: how playback
ownership works, how every transition is made click-free, the timing constants, the build pipeline
for the audio assets, and — equally important — the list of approaches that were tried and
**falsified**, so they are not re-attempted.

It is written to be rebuildable from scratch. The **Current Design** sections describe the
best-known-working solution as of 2026-06-03. The **Failed Attempts** section (§10) is history:
those branches are rejected unless new evidence directly contradicts the falsification.

> This document replaces and consolidates four earlier files (now deleted):
> `runtime-audio-ownership-rules.md`, `runtime-audio-stability-review.md`,
> `plan-tempo-crack-fix.md`, and `plan-signalsmith-streaming-track-change.md`. Where those are
> cited elsewhere, they mean this file.

---

## 1. The problem

The extension can play sound two ways: through **Bandcamp's own `<audio>` element** (origin) or
through **our extension runtime host** (a SignalSmith time-stretch worklet, required for Tempo
Adjust and Key Lock). Audible **cracks/clicks happen at the moment ownership moves between players,
or when one runtime track is replaced by another.** Startup delay happens when runtime preparation
blocks first audible playback. A correct design must protect both: origin keeps immediate
page-start playback; extension-controlled selections use runtime even if they must wait for prep.

Two hard testing constraints shape everything:

- **Firefox is the hard browser.** It renders **all `AudioContext`s on one shared audio thread**
  (call this **H1**), so work done on a "silent" second context is *not* off the audible path
  there. It also **does not expose `AudioContext` underruns** to the page (`underruns=-`), and
  `step`/peak were both falsified as crack detectors. So on the only browser that cracks, the
  crack is **ear-only** — no trace flag will show it. Chrome uses separate threads, reports
  `underruns`, and is already smooth.
- **Fast machines hide races.** A dev machine with fast buffer copies and quick host ACKs makes
  switch-time work sound clean while a slower tester machine cracks, because that work competes
  with the real-time audio thread. A fast-machine no-crack result is only a smoke test. **Slow-
  machine confirmation is release-gated** (cannot reproduce locally; needs a public release), so
  extract verdicts on local fast Chrome+Firefox first and minimize release rounds.

---

## 2. Ownership model (the contract)

At every playback moment exactly **one** owner is authoritative. The ownership state enum
(`RuntimeAudioOwnershipState` in `runtime-audio/types.ts`) is `origin-started`, `runtime-pending`,
`runtime` (a legacy `'none'` member exists but is never assigned — dead, safe to remove).

**Ownership is decided by who started the track:**

1. The **first Bandcamp-origin start is origin-owned** and may play natively immediately. First
   origin play MUST NOT wait for runtime preparation before audio starts.
2. **Extension playlist selections are runtime-owned**, including neutral tempo (`1.0000`). If the
   target is not prepared, pause the current audible owner, show the pending state, prepare, then
   start in runtime. Native audio is **not** a fallback for an extension selection.
3. **Runtime transport actions (SEEK, TEMPO ADJUST) are runtime-owned.**

**Origin ownership ends only on an explicit user action that requires SignalSmith: SEEK, TEMPO
ADJUST, or extension playlist selection.** Background preparation, source-change events, play
events, loaded-metadata, and prepared-ready events MUST NOT end first-origin ownership or restart
an origin-owned track through runtime. Once runtime owns playback, returning tempo to `1.0000` does
**not** hand ownership back to origin.

**Prepared ≠ owned.** "Prepared" means decoded/cached PCM exists. A prepared track may still be
playing through origin. Preparation alone never authorizes a runtime takeover.

### Definitions

- **Origin playback** — Bandcamp's page `<audio>` element (album/track pages) or the Discover
  page-context audio exposed through the origin bridge, is the audible source.
- **Runtime playback** — the extension SignalSmith host is the audible source. Every audible
  tempo-adjusted sample MUST come from here.
- **Prepared** — decoded or cached audio data exists for a track.
- **Host-loaded** — the runtime host has accepted the track data and can schedule playback without
  the expensive load. Stronger than prepared; still not ownership.
- **Runtime-owned** — the runtime host is the current audible source (`Runtime audio: owned=1`,
  playhead `bridge-runtime-owned`, tempo changes sync controls instead of reloading).
- **Handover** — audible playback moves from origin to runtime. High-risk: two audio systems near
  the same time.
- **Direct-start** — a selected track that requires SignalSmith starts directly in the runtime host
  instead of first playing natively. Required for prepared extension selections, neutral tempo
  included.
- **Neutral tempo** — desired rate exactly `1.0000`. Does not decide ownership.
- **Key Lock** — master-tempo behavior that keeps pitch stable while tempo changes. Do not change
  its default, hidden state, or availability as part of a crack fix without explicit approval.

### Non-negotiables

1. **Signalsmith-only tempo.** Native `audio.playbackRate`/`preservesPitch` is forbidden as a
   product path — not as fallback, safe mode, or silent degradation.
2. **No silent fallback.** If SignalSmith runtime is unavailable, Tempo Adjust fails closed with
   disabled controls / explicit unsupported state / visible debug — never a quiet engine switch.
   Fail-closed must be **visible**, not a swallowed warning.
3. **Prepared is not ownership** (see above); the debugger must distinguish the three states.
4. **Origin handover only on explicit SignalSmith action**, with origin protected until runtime is
   scheduled and origin is paused/silenced.
5. **Extension-selected tracks must be runtime-owned.** No `runtime-direct-start-skipped
   reason=neutral-tempo`.
6. **Runtime-owned tempo/seek must not reload the track** — only control sync.
7. **No behavior-changing default changes** (Key Lock, tempo engine, browser targets, permissions)
   without explicit approval.
8. **One owner per transition.** Passive source-change handlers must not race the active transition
   by loading/stopping the same target.
9. **Debug must describe reality.** If a track is prepared but a user action still needs a full
   load, the debugger must show it is not host-loaded / not runtime-owned.

### Discover specifics

Discover has no content-script `<audio>` element (`Audio element: missing (expected on discover)`).
Playable audio lives behind the page-context **origin bridge**, which exposes three owners: Discover
origin playback (feed changed the track), pending runtime selection, or runtime playback. The same
ownership rules apply. `runtime-source-changed` means the *selected* source changed — it does **not**
by itself mean runtime is audible; the Discover bridge receives `runtime-owns-playback` only from
the actual ownership-claim path. A Discover playlist click is an authoritative runtime selection,
never native detached playback.

---

## 3. Architecture: two-host ping-pong

Runtime playback uses **two long-lived `HostPlayer` instances** in
`content/player/runtime-audio/controller.ts`: `active` (owns audible output) and `idle` (kept
warm). Each is its own **iframe + `AudioContext` + SignalSmith worklet**. `host-player.ts` is
multi-instance-safe: each iframe is tagged with a unique instance id in a live-instance registry,
so injecting the second host does not tear down the first; cleanup removes only orphans from a
previous page load.

This design exists because the residual crack was pinned to the per-switch **`addBuffers`** load
(an O(bytes) PCM transfer into the worklet) running on the audible critical path. Ping-pong moves
that load off the audible host: it never disposes the outgoing host on the critical path, and it
pays worklet/context warmup once at startup, not per switch.

The transitions:

**Runtime → runtime switch** (`startRuntimeFromPrepared` + retire):
1. Load the next track into the silent `idle` host (`clear` + `addBuffers`) — off the audible path
   on Chrome; on Firefox see the chunked feed (§5) because of H1.
2. `playFromTime` on `idle` behind the handoff gate (§4.3).
3. Mark `ownership-transferred` and swap refs (`active`↔`idle`) **before** retiring the old host —
   so the retire's stop is not mis-flagged as `stop-dropped-target-buffer` against the fine new
   track.
4. Retire the old `active` off the audible path: **fade (20 ms) → output drain (`outputLatency +
   30 ms`) → clear**. This drain is the 3.4.32 property (the real outgoing-side fix); it is
   preserved, just moved off the audible path.

All transport/seek/tempo route through `active`; `wakeHosts()`/`pauseHosts()`/`destroy` hit both;
`onState`/`onEnded` are gated to the active host so the idle/retiring host can't blip the UI.

**First start / same-track / origin→runtime** use `active` directly (no warm idle exists yet for
the very first start).

A **`Runtime host pair`** debug line (`active=<id>:<trackId> idle=<id>:<trackId>`, trackId only, no
signed URL token) is the liveness signal: the `active` id flips on every runtime→runtime switch. A
never-changing id means ping-pong is not engaging.

What is genuinely good and must be kept: token-based staleness checks after every `await`
(`token !== transitionToken` / `destroyed`); the single `controlChain` serialization that stops two
transitions interleaving host commands; capability fail-closed; zero-copy transfer of channel data
into the worklet (avoids structured-cloning full PCM); identity guards (`sharesTrackIdentity`)
before pausing origin; and the ordered debug trace contract.

---

## 4. The transitions and how each is made smooth

### 4.1 Runtime → runtime (prepared → prepared)

Covered by ping-pong (§3): off-audible-path load → gated fade-in of the new host → fade + drain +
clear of the retiring host. The outgoing host is **never hard-stopped** — it is faded then drained,
which is what kills the stop-click.

### 4.2 Origin → runtime handover (the "mute" path) — now a fade

Triggered by SEEK / TEMPO ADJUST on an origin-owned track (and by detached direct-starts for their
first window). Shape (this is **Option A: mute before runtime work**, the confirmed crack-free
handoff from the tempo-crack investigation):

1. `silenceOrigin()` — silence the outgoing origin, then hold `ORIGIN_PRE_RUNTIME_MUTE_MS` (80 ms).
2. `startRuntimeFromPrepared(...)` — start runtime behind the handoff gate (same `scheduleImpl` as
   ping-pong, so it gets the cold-start warmup compensation in §4.3).
3. `runtime-ready-before-origin-pause` → `pauseOrigin()` → `origin-paused-for-handover`.
4. Restore origin volume/muted (now inaudible — origin is paused).

**The fade (2026-06-03 fix).** The outgoing origin used to be silenced with a single instant
`audio.volume = 0` write — an amplitude **step discontinuity = a broadband click**, the exact
artifact the ping-pong retire avoids with its 20 ms fade. The lesson transferred from ping-pong:
**never hard-cut an audible source; fade it.** `silenceOrigin` now ramps origin volume to 0 over
`ORIGIN_FADE_OUT_MS` (20 ms, 4 steps) via `fadeOriginVolumeToZero`, in **both** branches (attached
`<audio>` and detached/Discover-bridge), and sets `muted=true` only *after* the ramp (muting
mid-fade would re-introduce the hard cut). `HTMLMediaElement.volume` is a plain setter (no
`AudioParam`/`linearRampToValueAtTime`), so it is a small stepped ramp, not a WebAudio ramp.

This was reported by the user as fixing the residual handover roughness "entirely."

**Why no separate drain-before-pause is needed here:** unlike the ping-pong retire (which clears
immediately after fade), the origin handover's `pauseOrigin()` runs only *after* the 80 ms hold
**and** the entire runtime start. By the time `audio.pause()` fires, origin has been at volume 0 +
muted for well over 100 ms, so the native pause already lands on long-silent output. Adding a drain
tick would be redundant (kept lean per the simplify-first rule).

The `originProtectionDepth` counter wraps the whole silence: while it is > 0, the origin element's
observed state is **not** captured as the user's volume — this prevents the protective `pause`/mute
from poisoning `lastUserVolume`/`lastUserMuted` (which once caused "volume stuck muted after a
protective origin mute").

`shouldMuteOrigin = needsLoad || (origin.playing && muteOriginBeforeHandover)`; the handoff gate is
applied iff `shouldMuteOrigin`.

### 4.3 Cold-start handoff-gate warmup compensation

In `runtime-audio-host.ts scheduleImpl`, a cold start's pre-audible worklet warmup is
`prerollOutputSec + HANDOFF_GATE_HOLD`. `prerollInputSec = isColdStart ? min(START_PREROLL, safeTime)
: 0`. A **track change starts at `safeTime≈0` → preroll 0 → only ~120 ms warmup**; a **mid-track
start → preroll 30 ms → ~150 ms warmup**. That shortfall is the difference between a cracking t=0
track change and a clean mid-track start (it is also where the worklet is most likely cold —
`state=suspended`, `stretchFactory` built inline at switch time).

Fix: for cold starts, **hold the handoff gate longer by the missing preroll**, so a t=0 start gets
the same total warmup (~150 ms). Debug shows `gate=150ms/30ms` on track changes vs `gate=120ms/30ms`
on mid-track handovers. This benefits *every* runtime first window, including the origin→runtime
handover (same `scheduleImpl`). The deeper fix, if 150 ms ever proves insufficient on the slow
machine, is to **warm the worklet at the decoded sample rate during predecode** — but never warm
*before* the track's sample rate is known, or it forces a later rebuild crack (the anti-prewarm
constraint).

### 4.4 Firefox chunked/incremental worklet feed

Root cause (instrumented): `addMsPerMB ≈ 1.0` constant across track sizes ⇒ the per-switch
`addBuffers` cost is an **O(bytes) PCM transfer** into the worklet (one ~100 MB track ≈ one ~120 ms
transfer) that blocks Firefox's shared audio thread (H1) and overruns the ~28 ms output ring. That
is the crack on slow machines / a "tiny stumble" on fast ones — the same event.

Fix: feed the decoded track to the worklet as **~3 MB slices with a ~12 ms yield between each**
(`runtime-audio-host.ts` LOAD_TRACK, `chunkedFeed`), so no single transfer exceeds the ring.
**Firefox-only by design** (Chrome's transfer is free / separate threads, so chunking would only add
latency): gated on the build-time `__BUILD_TARGET__` constant; **default-on** for Firefox with
kill-switch `localStorage __BC_RUNTIME_CHUNKED_FEED__=0`; on Chrome the branch is
dead-code-eliminated to the single-shot load. Requires the worklet multi-chunk feeding-loop patch
(§7, patch #7). Debug: `host-load-timing … chunks=<n> maxChunkAddMs=<ms>` (drops from ~125 ms
single-shot to 12–67 ms). By-ear verdict on fast Firefox: no crack, no stumble; slow-machine is
release-gated.

**Known tradeoff (parked):** the chunked load is ~0.8–1 s total, so Firefox switches have a
perceptible click→playback delay. Accepted as the cost of clean playback. Future levers: larger
slices / shorter yield; drop the explicit yield and rely on the `addBuffers` round-trip as spacer;
skip chunking on the first runtime start / when no sibling host is rendering (nothing to protect
there, so the latency is pure waste); throttle concurrent predecode during a switch.

### 4.5 Encoded-blob retention (prep cache)

Firefox hides `navigator.deviceMemory`, so the engine uses the conservative profile and once kept
only decoded PCM — playlists beyond the budget evicted and **re-fetched + re-decoded** on every
revisit (reload-on-click thrashing). `engine.ts` now **retains the small encoded blobs** (~5 MB/
track, ~128 MB budget = a whole playlist) across decoded-PCM eviction, so a re-selected track is
**decode-only, no network**. Decoded-PCM peak (the conservative profile's purpose) is unchanged.
Debug: `Runtime cache … encodedCache=<n>:<bytes>/<budget> encHits=<n>`, plus `fetch=0ms` +
`encoded-cache-hit` on a revisited track.

### 4.6 Memory-aware predecode policy

`src/shared/runtime-predecode-policy.ts`. The active playlist preparation window is the current
track plus a bounded number of following playable tracks, wrapping at the end, shared by Discover
and non-Discover, and memory-aware:

| Signal | Tracks (~budget) | Parallel |
|---|---|---|
| No memory signal (≈ all Firefox, "unknown") | 8 (~850 MB) | 2 |
| `deviceMemory` < 4 GB (Chrome only) | 6 (~440 MB) | 1 |
| `deviceMemory` < 8 GB | 8 (~750 MB) | 2 |
| `deviceMemory` ≥ 8 GB | 10 (~1200 MB) | 3 |
| Performance opt-in (Chrome) | window 24 / retention 30 (~2900 MB) | 4 |

The Firefox/unknown floor was raised from 4/440 MB to 8/850 MB on 2026-06-02: the chunked feed
removed the load crack and encoded retention makes eviction cheap, so the rock-bottom floor is no
longer warranted (residual risk on a genuinely low-RAM Firefox box is release-gated/reversible).
The window includes a **look-behind** (`player/index.ts buildPlaylistRuntimePredecodeQueue`):
current + (window−3) ahead + 2 behind, prepared current→ahead→behind, so back-jumps are instant
too. The playlist header shows the BPM/key-style spinner while in-window tracks are actively in
flight (a full cache does not hide that work while older entries are replaced); a visible `!` means
runtime preparation recorded a real fetch/decode error.

Started preparations continue when selection moves within the playlist; identical prepared/in-flight
identities are reused; a true origin switch cancels the old source context and replaces its window.

### 4.7 Chrome-only Performance mode (opt-in)

Chrome caps `navigator.deviceMemory` at 8, so high-RAM machines can't climb past `memory-gte-8gb`
automatically. A user setting (`performanceModeEnabled`, default off) unlocks the higher tier in
`runtime-predecode-policy.ts` (`reason:'performance-opt-in'`): the first tier where window ≠
retention, giving instant **lookback** to recently-played tracks. The gate is `__BUILD_TARGET__ ===
'chrome' && settings.performanceModeEnabled`, resolved once in `index.ts` and injected into the
engine as `predecodePolicy` (single source of truth). The Firefox build dead-code-eliminates the
toggle UI and the gate, so a synced `true` can never raise the Firefox tier. The toggle does not
flip inline: it opens a Chrome-only confirm dialog and only on confirm persists + `reload()` (the
engine reads the policy once at construction).

**Discover is at full parity with the player** (2026-06-03). It previously self-resolved the policy
without the Performance gate *and* without injecting it into the engine, so on Chrome it stayed on
the default/`memory-unavailable` tier (window 8) while the player honored Performance mode (window
24) — "Chrome prepares fewer tracks on Discover." `content/discover/controller.ts` now resolves the
policy **once** with the same `__BUILD_TARGET__ === 'chrome' && settings.performanceModeEnabled`
gate and injects it via `createRuntimeAudioEngine({ predecodePolicy })`, reusing that single object
for its `windowTracks`/`maxConcurrentPredecode` math. The shared Performance-mode confirm dialog
reloads on toggle, so Discover picks up the new tier the same way the player does.

### 4.8 Direct-start outgoing-origin pause (bandcamp-root) — partially mitigated, not solved

Selecting a prepared playlist track while a track is playing through **native origin audio**
(`enqueueRuntimePlaylistStart`, controller.ts) must stop that outgoing element. On bandcamp-root the
outgoing element is a **Bandcamp `new Audio()` instance that is *not* in the DOM** — the content
script (isolated world) cannot reach it: `document.querySelectorAll('audio')`, `pauseAudio`, and
`audio.volume` are all inert on it, and `readOriginSnapshot()` reports `playing=0 src=-`. Only the
**page-context bridge** (`discover/origin-bridge/script/section-a.ts`) can control it, via its
`window.Audio` wrapper → `trackedAudios`.

The audible **hard cut is Bandcamp's own player calling `pause()`** on that element, at full-ish
volume, on a **racy schedule** (~tens of ms after the click) — *not* our content-side pause and *not*
the page-context mute paths. It is intermittent because of a 3-way timing race: the content→page
command hop (~80 ms, stretches under the busy selection main thread), the `setTimeout` volume-ramp
steps (browser clamps timers to ~4 ms), and Bandcamp's variable pause time. Outcome ranges from
silent (fade reached 0 first) → half click (paused mid-fade) → full click (paused before the fade ran).

**Shipped mitigation (kept):** `bridge.prepareRuntimeTakeover()` → page-context `fadeAndPauseTrackedAudio`
(a ramped variant of `muteAndPauseTrackedAudio`, `ORIGIN_FADE_OUT_MS`/`ORIGIN_FADE_STEPS`) ramps the
element toward 0 before `bridge.pause()`. This **halves** the click (often inaudible) but cannot
*eliminate* it — see §10. The runtime host first window itself is clean here; the artifact is purely
the outgoing pause.

---

## 5. Timing constants (the knobs)

Audio-host constants in `runtime-audio-host.ts`; controller constants in `controller.ts`. These
are **independent on purpose** — do not couple host DSP timings to controller timings.

| Constant | Value | Where | Role |
|---|---|---|---|
| `MICRO_FADE_SECONDS` | 8 ms | host | fade-in for ordinary cold starts / pause-resume |
| `PAUSE_FADE_SECONDS` | 20 ms | host | fade-out before pausing/stopping (no stop click) |
| `START_PREROLL_SECONDS` | 30 ms | host | muted preroll before the audible handoff point |
| `HANDOFF_GATE_HOLD_SECONDS` | 120 ms | host | hard-mute SignalSmith's first handoff blocks |
| `HANDOFF_GATE_FADE_SECONDS` | 30 ms | host | gate release fade |
| `OUTPUT_DRAIN_SAFETY_SECONDS` | 30 ms | host | keep faded output alive past sink latency (3.4.32) |
| `TIME_UPDATE_INTERVAL_SECONDS` | 50 ms | host | timeupdate cadence |
| `ORIGIN_PRE_RUNTIME_MUTE_MS` | 80 ms | controller | hold after silencing origin before host work |
| `ORIGIN_FADE_OUT_MS` / `ORIGIN_FADE_STEPS` | 20 ms / 4 | controller | origin fade-out ramp (§4.2) |
| `RUNTIME_SEEK_FRACTION_EPSILON` | 0.001 | controller | dedupe near-identical runtime seek fractions |
| `RUNTIME_SEEK_REPEAT_SUPPRESS_MS` | 250 ms | controller | suppress repeat seek dispatch window |

Note `ORIGIN_FADE_OUT_MS` deliberately mirrors the host's `PAUSE_FADE_SECONDS` (20 ms): both are
"fade an audible source to silence instead of stepping it." The seek epsilon (~240 ms over a
4-minute track) combined with the 250 ms suppression window can drop a fine drag to a nearby-but-
distinct point as a "repeat" — a minor known UX wrinkle in the runtime-owned seek coalescer.

---

## 6. Debug signatures (prove each path ran)

The debug panel is always live (info menu or **Alt+D**); copy export omits identity/auth/paths/
device/browser-audio/signed-URL tokens while keeping played-track + operational diagnostics. Keep
these fields visible (they were repeatedly lost to trace truncation — add a stable summary field
rather than relying on chronological lines):

- current owner: origin / pending-runtime / runtime; and whether the track is prepared, host-loaded,
  or runtime-owned
- `Runtime origin mute` (durable field for the early origin mute, survives truncation)
- `Runtime host schedule`, `Runtime host first window`, `Runtime host clipping`, `Runtime host pair`
- per-track prep timing (fetch / decode / total / cache age); `Runtime cache … encodedCache=… encHits=…`
- whether a tempo action caused a host load/handoff or only a control sync
- any `processorerror`, especially `RangeError: source array is too long`

Expected sequences:

- **Origin-owned SEEK / TEMPO ADJUST handover:** `origin-muted-before-runtime-work … holdMs=80
  fadeMs=20` → (`loading-track` if not host-loaded) → `host-handoff-gate` → `host-play-scheduled …
  gate=150ms/30ms` (t=0) → `runtime-ready-before-origin-pause` → `origin-paused-for-handover` →
  `ownership-transferred`.
- **Neutral extension playlist selection:** `select-playlist-track` → `runtime-playlist-load-enqueued`
  (prepared) or `runtime-waiting-for-prepared` (unprepared) → `host-play-scheduled` →
  `runtime-ownership owned=1`. **No** `runtime-direct-start-skipped … reason=neutral-tempo`.
- **Runtime → runtime switch:** `ping-pong-load-into-idle` → `host-swapped active<-idle` →
  `ownership-transferred` → retire (`host-stop-fade` → `host-output-drain` → `host-stop-timing`) →
  `Runtime host pair` with a flipped active id.
- **Runtime-owned tempo/seek:** `runtime-active-controls-synced rate=… keyLock=1`; **no** same-track
  `loading-track`, **no** origin mute/pause.

---

## 7. Build pipeline for the audio assets

Production prebuild chain (see `rules/build-rules.md` for the full table):

1. `tools/build/preflight-build-guard.js` — workspace/version/manifest contract checks.
2. `tools/build/copy-custom-essentia-wasm.js` — installs the custom Essentia WASM build.
3. `tools/build/patch-essentia-no-eval.js` — removes CSP-violating dynamic-code patterns.
4. `tools/build/generate-signalsmith-worklet.js` — regenerates the checked-in SignalSmith worklet
   from npm on every build, then applies **fail-loud** post-generation patches: branch-1 dead-code,
   `clearBuffers` (no discarded-PCM transfer back to the host), and **patch #7, the multi-chunk
   feeding-loop fix**. Verify with `node tools/build/verify-signalsmith-worklet-feeding.js`
   (machine-independent: single-track byte-identical + multi-slice safe).
5. `webpack --env target=<browser> --mode production`.
6. `tools/build/patch-webpack-no-eval.js <browser>` — removes `eval`-like webpack runtime behavior.

**Patch #7 — the worklet multi-chunk feeding-loop fix (LIVE).** The generated
`src/assets/vendor/signalsmith/worklet.js` had a bug: `addBuffers` just pushes (cheap, no size cap),
but the buffered-playback feeding loop bounded its copy `count` by the input span (constant ≈
`bufferLength`, never decremented) instead of by the **remaining destination**, and advanced the
cursor by `count` instead of the whole chunk length. With **one** chunk it ends cleanly (every
normal load); with **two+** chunks it does `.set()` into a zero-length tail → `RangeError: source
array is too long`. The patch clamps `count = min(chunk_remaining, bufferLength - blockSamples)`,
advances the cursor by the whole chunk, and breaks when the block is full. The patch **fails the
build if its target substring is absent**, so a SignalSmith version bump cannot silently drop it.

This patch is what makes the Firefox chunked feed (§4.4) possible — **one** track fed as several
`addBuffers` slices is now proven safe. It is **not** a license to put **multiple distinct tracks**
in one timeline (the streaming experiment that did so is reverted — §10).

Build/verify gates for any source change: `npx tsc --noEmit`, `git diff --check`, `npm run build`
(Firefox → `dist/firefox/`), `npm run build:chrome` (Chrome → `dist/chrome/`). The runtime path is
shared, so audio changes require **both** builds.

---

## 8. Verification matrix

Every runtime-ownership change must be checked against:

1. First play from an origin-owned track.
2. First-origin SEEK handover. / 3. First-origin TEMPO ADJUST handover.
4. Tempo adjustment while already runtime-owned. / 5. Seek while runtime-owned.
6. New selection at neutral tempo `1.0000`. / 7. New selection while runtime-owned.
8. Tempo returns to `1.0000` (must stay runtime-owned).
9. Key Lock remains enabled/unchanged unless explicitly approved.
10. Runtime→runtime replacement on a slow/throttled machine (the `Runtime host pair` active id must
    flip; retire shows fade→drain; first window below clipping).
11. First-origin playback while background decode runs — **no** host `addBuffers()` and **no**
    processor errors before a runtime transition is requested.

None of these is "done" on a fast local machine — fast machines hide races. The crack itself is
judged **by ear on the slow machine**, which is release-gated.

---

## 9. Hardware-timing & simplify-first rules

- **Fast machines can hide races.** Prove transition *ordering* in the trace, don't trust a local
  no-crack result. Ask testers whether their machine is slower than the dev machine, and request
  Copy All immediately after a crack, before changing tracks again.
- **Simplify first.** Before adding any guard / special case / fallback / retry / mute branch /
  ownership flag / timing workaround: (1) remove duplicate paths, (2) replace vague state with
  explicit state, (3) remove hidden fallback behavior, (4) make one transition deterministic, (5)
  only then add the smallest needed protection — and only if the debugger can prove it ran. The bug
  was never "a missing guard"; it was too many helpers acting on the same transition.
- **Background preparation MUST NOT call host `addBuffers()` while origin or runtime playback is
  audible.** Fetching/decoding into content-side buffers is fine; loading the host is playback work.
  (Ping-pong satisfies this by loading into the *silent* idle host; the chunked feed keeps even that
  load from stalling Firefox's shared thread.)
- The silence-tail mechanism is best-effort (`waitUntilContextTime` is a wall-clock `setTimeout`,
  not an audio-clock guarantee; `outputLatency` is a coarse estimate Firefox often reports as 0,
  covered by the fixed 30 ms safety). If a drain ever proves unreliable, make it closed-loop
  (re-check `ctx.currentTime` after the sleep and re-arm once) rather than adding more fixed waits.

---

## 10. Failed attempts — do not revive without new contradicting evidence

### Track-replacement / host-lifecycle chronology

- **3.4.12 — multiple full tracks in one SignalSmith input timeline:** failed at playback with
  `RangeError: source array is too long`. Root cause later understood as the worklet feeding-loop
  bug (now patch #7). Appending multiple *distinct* tracks to one timeline is still not a product
  path.
- **3.4.24 — neutral native-detached selection:** made neutral extension selections play through
  native detached audio (`runtime-direct-start-skipped reason=neutral-tempo`). Fixed track-change
  crack on one machine but **violated runtime authority and moved the crack to the first later seek/
  tempo handover.** Rejected.
- **3.4.26 → 3.4.31 — escalating stop/clear/teardown before reload:** post-pause quiet window
  (3.4.26); full host stop/clear before load (3.4.27, still cracked at `activePcm=0.0MiB`); rebuild
  graph in the same iframe (3.4.28, still cracked, lifetime reached `loads=50 graphs=49`); destroy +
  recreate iframe (3.4.29); wait for `AudioContext.close()` ACK (3.4.31, still cracked with
  `contextClosed=1`). Each was added when the prior failed; all falsified. **3.4.30** (target-only)
  is rejected separately because it removed the prepared-track speedup.
- **3.4.32 — outgoing output drain: KEPT.** Holding silence (`outputLatency + 30 ms`) until the
  browser/driver buffer drains before disposing the old host was the real fix on the **outgoing**
  side. This is the property the whole ping-pong design preserves (just moved off the audible path).
- **3.4.33/3.4.34 — long-lived single host + byte-aware retention:** improved the slow machine
  ("less but still single cracks"); residual crack pinned to load-on-critical-path (`addBuffers`,
  `host-load-stall phase=add addMs≈149–167`). This motivated ping-pong.
- **3.4.35 — two-host ping-pong (on-demand): KEPT** (current design, §3).
- **Predictive ping-pong (Stage 2)** — eagerly load N+1 into the idle host while N plays:
  **falsified on Firefox.** It audibly disturbed the active track (`duplicate-host-load-detected`,
  `host-load-stall maxGapMs=169 phase=add` during steady playback). This **confirmed H1** (one
  shared audio thread on Firefox), so the idle-host load is *not* off the audible path there.
  Reverted. (The chunked feed §4.4 is the answer to H1, not prediction.)
- **Whole-window single-timeline append** — REJECTED (not built): would cover random jumps but holds
  N decoded tracks in one worklet (~3× ping-pong memory), the exact pressure implicated in the
  crack, on the one constrained profile that matters.
- **Single-instance streaming track-change (Phase B)** — append-ahead + `schedule({input})` seek on
  one instance to replace the bulk per-switch load: built behind a flag, then **reverted.** It only
  helps *sequential* forward switches (prediction-dependent); the Firefox crack is on *random*
  prepared-track jumps, and Chrome is already smooth — so it offered nothing for the actual goal. A
  single instance also cannot isolate the load (appending while it plays competes with the current
  track's render on the same context). Resurrectable from git if a Chrome-only optimization is ever
  wanted. **Phase A (the worklet feeding-loop fix) was kept and re-added as patch #7** because the
  chunked feed needs it.

### Tempo-crack branches (from the long first-tempo-adjust investigation)

The crack on first tempo adjust was ultimately fixed by **muting origin before runtime host work +
the hard handoff gate + Signalsmith-only output** (the Option A handoff, now enhanced with the §4.2
fade). Everything below was tried first and **did not** solve the audible artifact — do not make any
of them a *primary* next move:

- native media-element tempo as a product route (used only as a **diagnostic control sample** — it
  removed the crack, which is what implicated the origin→SignalSmith handoff boundary — never shipped)
- output-headroom tuning as the main fix; soft limiter as the main fix
- cheaper SignalSmith preset; custom `blockMs`/`intervalMs`/`splitComputation` (changed the sound)
- bootstrap worklet takeover; fixed release-hold startup; primed paused runtime startup
- first-takeover debounce/settle; pre-arm; snapshot-age splice compensation
- live-input SignalSmith replacement for buffered playback; restart-style runtime tempo changes
- generic origin duck/fade tuning *after* ownership is already unclear; broad mute-everything

Lesson: many of these added complexity without a reliable audible fix and made the crack "move
around." Clarify ownership and remove overlap before adding any new timing/mute behavior. The
diagnostic value of the native-tempo control was real; shipping it is not.

### Direct-start outgoing-origin pause branches (§4.8)

The residual bandcamp-root direct-start click is Bandcamp hard-pausing its own non-DOM `new Audio()`.
Tried 2026-06-05; only the page-context fade (§4.8) was kept (halves it). The rest:

- **Content-side fade of the native element** — REVERTED. Wrong layer: the element is a `new Audio()`
  not in the content DOM, so content-side `querySelectorAll`/`volume`/`pause` are inert on it. Do not
  re-attempt a content-side fade for this path.
- **Web Audio `GainNode` sample-accurate ramp** — INFEASIBLE. The stream is cross-origin
  (`bandcamp.com/stream_redirect`), so a `MediaElementAudioSourceNode` taints to silence.
- **Faster / front-loaded `HTMLMediaElement.volume` ramp** — rejected as a non-fix: bigger steps just
  move the click to fade-start, and the ~4 ms timer clamp caps ramp speed, so it can't reliably reach
  0 before Bandcamp's pause.
- **Takeover-scoped wrap of `HTMLMediaElement.prototype.pause`** (fade-then-pause, gated to the
  ~200 ms takeover window) — the *only* deterministic fix, **declined by the user as too risky** for
  the page-context bridge. Resurrect only if the halved click becomes unacceptable; keep it gated to
  the takeover window so normal pauses pass straight through.

Note the temporary debug fields used to pin this (`Owned playback outgoing stop` / `… takeover prep`
/ `Runtime outgoing origin stop`) were removed after the verdict; re-add equivalents if reopening.

---

## 11. Open items / future work

1. **Confirm by ear on the slow machine** (release-gated): the cold-start gate=150ms warmup (§4.3),
   the chunked feed (§4.4), and the origin fade (§4.2). Fast Firefox+Chrome are clean.
2. **Continuous 2× worklet CPU (battery):** the idle host's keep-alive pins its context running.
   Parking it when idle is the candidate fix but touches the fragile lifecycle.
3. **Origin-track predecode stall (parked):** selecting the page's own origin track under a full
   cache on the conservative profile can stall in `runtime-waiting-for-prepared`.
4. **Chunked-feed latency (~0.8–1 s):** tune later (levers in §4.4).
5. **Cleanups flagged but not done:** delete the dead `'none'` ownership state; split the overloaded
   `stop()`/`destroy()` into `pausePlayback`/`clearLoadedTrack`/`replaceLoadedTrack`; make timing
   waits cancelable by `transitionToken`; surface a *visible* runtime-host-error state instead of a
   swallowed warn; drop the redundant pre-destroy `clearBuffers`/`freshGraph` in any teardown path.

---

## 12. Files

- `src/content/player/runtime-audio/controller.ts` — ownership state machine, ping-pong, handover,
  origin silence/fade, seek/tempo coalescing.
- `src/content/player/runtime-audio/host-player.ts` — multi-instance-safe host wrapper (iframe +
  context + worklet), instance registry.
- `src/content/player/runtime-audio/engine.ts` — decoded-PCM + encoded-blob cache, predecode.
- `src/content/player/runtime-audio/{dsp,loader,origin-snapshot,playlist-prep-status,signalsmith-probe,types}.ts`
- `src/runtime-audio-host.ts` — the in-iframe host: `scheduleImpl` (gate/preroll/warmup),
  fade/drain, `LOAD_TRACK` + chunked feed.
- `src/shared/runtime-predecode-policy.ts` — memory-aware window/retention/parallel policy.
- `src/content/player/index.ts` — predecode queue (look-behind), policy injection, handoff wiring.
- `src/content/discover/controller.ts` — Discover runtime ownership via the origin bridge.
- `src/content/discover/origin-bridge/…` — page-context audio bridge.
- `src/assets/vendor/signalsmith/worklet.js` (generated) + `tools/build/generate-signalsmith-worklet.js`
  (+ patch #7) + `tools/build/verify-signalsmith-worklet-feeding.js`.
- `src/ui/components/settings.ts` — Chrome Performance-mode toggle + confirm dialog.
- Debug: `src/content/debug/…`, `src/ui/debug-panel/…`.
