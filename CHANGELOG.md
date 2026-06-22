# Changelog

All notable changes to Bandcamp Deck are recorded here, one entry per released version. It is written for people rebuilding the extension, so entries carry the technical detail needed to understand what changed and why. This file reflects version updates only — entries are added when the version number is bumped, not per commit.

## Unreleased

- About panel: rewrote the About text (`src/ui/components/why-two-keys-panel.ts`) to lead with the extension's own audio engine and the two projects behind the core features (Signalsmith Stretch for Tempo Adjust, Essentia for BPM/key/waveform), added a memory/Performance-mode note, and shortened the key-analysis section.
- Welcome panel: reworked the welcome gate (`src/ui/components/welcome-gate.ts`) into a paged walkthrough — three curved-divider bands (welcome / slides / dismiss), Back/Next arrows with a dot indicator, trackpad swipe navigation, feature chips, a compact keyboard-shortcuts grid, and a revised feedback/tip slide.

## 3.6.4 — 2026-06-22

Version `3.6.4` is a UI-appearance release.

Main improvements:
- Appearance panel: the Alt+G glass tuner becomes a full Appearance panel (`appearance-panel.ts`, Settings → **Appearance / Edit**), restyled to the main UI's light glass and attached flush to the panel's left edge with live drag/resize tracking and an inline Frost slider.
- Camouflage layer: a new toggle adds tiled grey radial blobs that blend into the glass and keep their form as the panel grows.
- Letterpress idle wordmark: `BANDCAMP // DECK` is pressed into the glass with a layered text-shadow.
- Welcome-gate copy now points to Settings → Appearance and uses a centered, unnumbered list.
- Open-album button: now hidden whenever the panel is idle on every page type. Visibility is decided once in the panel (`panel.ts`, idle + valid album URL); the redundant source/playback gate in `state-sync.ts` was removed, so it no longer lingered on idle release pages.

## 3.6.3 — 2026-06-20

Version `3.6.3` reworks the welcome gate (`src/ui/components/welcome-gate.ts`) into a single window.

Main improvements:
- Single-window welcome gate: the two-slide flow is gone. The separate "What's new" slide (per-version changelog badges) and the `NEXT → LET'S GO` slide-switching state machine (`setSlide`/`currentSlide`) were removed, along with all the slide-specific CSS (`.is-slide-1`, the per-bullet/`ver-label` styling). The single button now confirms and closes directly. Version gating (show once per version via `bc:welcome:last-seen-version:v2`, plus the pending-version force-show on update) is unchanged, so the gate still re-appears after a version bump.
- Updated getting-started tips: the gate now shows one numbered list (`<ol>`) covering panel resize, panel opacity (Settings → Glass effect), track preloading, key analysis, Performance mode (Chrome only, announced on both browsers), and keyboard shortcuts. The list is left-aligned; the header, version line, and button stay centered. The feedback note is retained below the list. Body/title font sizes were nudged down slightly (title 19→17px, body 11→10.5px) to fit the longer single-window list.
- AMO lint cleanup: the idle metadata placeholder (`BANDCAMP // DECK`) in `src/ui/components/metadata-display.ts` no longer assigns `innerHTML`. The separator span is now built from DOM nodes via `replaceChildren`, clearing the two "Unsafe assignment to innerHTML" warnings the Firefox add-on linter raised against the bundled `content/discover` and `content/player` scripts (the source line was shared into both bundles).

## 3.6.2 — 2026-06-20

Version `3.6.2` centers on two things: a systematic, area-by-area **code simplification review** and an **overhaul of the `rules/*.md` documentation**. Along the way it also hardens playback/session state after idle periods and collects the reliability fixes since `3.6.1`.

Main improvements:
- Code simplification review: every major area (runtime audio, BPM/key, metadata/Tralbum, likes/playlist, Discover, UI, background) was reviewed in turn to remove dead code, consolidate duplicated helpers (number clamping, storage wrappers, worker dispatch, theme variables, key tuning, Discover metadata/preload), and collapse layered paths into one. Several latent bugs surfaced and were fixed in the same pass: the likes double-toggle race (with the dead background mutation engine deleted), deterministic likes retry backoff, key analysis bound to the settled BPM, Discover release-only identity locks closed, and the camelot `10A/11A/12A` parse fix.
- Rules documentation overhaul: the `rules/*.md` docs were revised to a common structure with two tiers — deep, rebuildable subsystem references (`audio-rules`, `bpm-analysis-rules`, and a new `wishlist-and-collection` reference covering inventory sync + collect/uncollect mutation) and lighter area maps (`architecture`, `build`, `metadata`, `debug-ui`, and `playlist-rules`, renamed from `likes-playlist-rules` to match its trimmed scope). Each doc now carries a scope line and cross-links, and `AGENTS.md`/`README.md` index the full set.
- Discover idle preservation: temporary empty stream URLs no longer collapse the preserved playlist and current-track state after idle or wake. The controller keeps the last known state visible and adds a throttled `idle-state-preserved` trace when that path is used.
- Loading and status correctness: wishlist/collection foreground sync keeps the UI loading state active until the real sync promise settles, METADATA no longer shows a false loading chip when the default title is legitimate, and BPM attempts are counted only when analysis actually starts.
- Playback and playlist reliability: runtime audio ownership now keeps origin playback authoritative, stale-host overlap is simplified, playlist resolving/sorting uses one shared path, current-index ordering is fixed, and playlist decoration normalizes cache-key reads with clearer 0-BPM display.
- Build hygiene: the build chain now includes the lockfile/Node pin/worklet verification cleanup from this cycle.

## 3.6.1 — 2026-06-13

Version `3.6.1` gives the panel a real liquid-glass surface and the tooling to tune it, plus task-manager-style resource diagnostics in the debug panel.

Main improvements:
- Liquid-glass panel surface: the panel now renders as frosted glass (backdrop blur + tint on both browsers; Chrome additionally runs an inline SVG edge-refraction filter). Panel drag moves the surface via a compositor-only translate so the glass stays live during the drag.
- Glass tuning: a single "Frost" control replaces the earlier per-effect sliders. Tint and blur are coupled on one 0..1 position (`tint = pos`, `blur = pos * 10`), so one slider drives the look from clear to full frost; the calibrated default sits at 0.65. It is reachable from the Alt+G tuner and from a new Settings → Glass effect entry.
- Resource diagnostics: the debug panel's Performance area now reports per-context event-loop lag, JS heap (where available), worker busy fraction, WASM/cache bytes, and audio-host underruns. Sampling is gated entirely on the panel being open, so there is no idle overhead during normal playback.
- Idle placeholder polish: the "BANDCAMP // DECK" idle text is slightly larger and semi-transparent, with the "//" separator tinted a dark grey.

## 3.6.0 — 2026-06-10

Version `3.6.0` focuses on BPM analysis accuracy and the waveform visualization.

Main improvements:
- BPM detection now runs two independent algorithms and cross-checks their results, so the reported tempo is more accurate. Analysis takes slightly longer in exchange for fewer wrong or half/double-tempo readings.
- The waveform visualization was reworked to sit much closer to Rekordbox, so the shape reads against a familiar reference.

## 3.5.0

Version `3.5.0` adds Performance mode, a Chrome-only opt-in that preloads more of the playlist ahead so skipping between tracks stays instant on machines with plenty of memory.

Main improvements:
- Performance mode (Chrome only): an optional higher preload tier that keeps more of the playlist decoded and ready, so jumping between tracks is near-instant. It uses noticeably more memory and is meant for machines with 16 GB+ of RAM. The page reloads when you toggle it so the audio engine picks up the new policy.
- Why it stays a manual opt-in (not automatic): reserving that much memory for a browser extension should be the user's deliberate choice, not something the extension switches on by itself. On top of that, Chrome reports at most 8 GB through `navigator.deviceMemory`, so the extension can't reliably detect that a 16/32/64 GB machine has spare headroom anyway.
- Why Chrome only (not Firefox): Firefox runs the extension's runtime audio on a shared audio thread, so a much larger preload/decoded-audio working set would compete with playback instead of staying off the audible path. The aggressive tier is therefore intentionally Chrome-only.

## 3.4.5

Version `3.4.5` keeps the current-track waveform path deterministic after partial BPM analysis. The current track now hydrates waveform data through the same explicit `GET_WAVEFORM` request path used by preload, so Firefox no longer waits on a delayed background update that may arrive after the tempo listener has detached.

Main improvements:
- Current-track waveforms settle reliably after BPM analysis, including on fan feed and wishlist playback.
- Partial BPM results no longer publish partial waveform data as if it were a complete waveform.
- Preload remains unblocked while the current waveform hydrates, so nearby track BPM and waveform preparation can continue.

## 3.4.2

Version `3.4.2` builds on the reliability work for moving between release pages, fan pages, feed/recommendation pages, and Discover, while adding configurable keyboard controls for faster playback and tempo workflows.

Main improvements:
- Keyboard shortcuts can be customized from the panel settings, including play/pause, playlist navigation, seeking, tap tempo, and tempo adjustment controls.
- Metadata is resolved API-first, so track titles, artists, albums, and release identity come from Bandcamp's structured data whenever possible.
- Discover playback is tracked through a page bridge, so the panel can follow the currently playing audio even when Bandcamp does not expose the same globals used on release pages.
- Long artist, album, and track names now gently scroll inside the panel header instead of being cut off permanently.
- BPM, waveform, and optional key analysis are cached per track and preloaded for nearby playlist rows.
- Tempo Adjust uses SignalSmith-powered time-stretching so BPM changes can keep playback usable instead of only changing the browser playback rate.
- Wishlist and collection state are synchronized against Bandcamp inventory before the panel decides whether an item is liked, disliked, or bought; feed and recommendation track mutations also use the page-context mutation path Bandcamp expects.
- Download pages are excluded from the player script so Bandcamp purchase/download flows stay clean.
- The security boundary is tighter: playback-audio background fetches are limited to HTTPS Bandcamp/Bcbits hosts, and Firefox no longer rewrites Bandcamp CSP headers.
