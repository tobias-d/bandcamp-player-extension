# BPM / Tempo Analysis — Rules & History

Single reference for how BPM detection works, what we learned from the correction attempts, and
the guardrails that protect against re-introducing old regressions. This consolidates four deleted
docs (`docs/bpm-analysis-findings.md`, `docs/bpm-attempt-4-plan.md`, `docs/analysis-parallelism-plan.md`,
`docs/key-analysis-loading-and-ownership-plan.md`) and `tempo-seek-experiments.md`, updated to the
**current build (v3.6.0)**.

> Scope: this is **tempo/BPM detection accuracy**. Runtime *playback* (cracks, handoff, SignalSmith)
> lives in `rules/audio-rules.md` — different topic despite the overlapping "tempo" word.

---

## 1. Pipeline (current, live)

Base estimate → optional beat-evidence correction → optional deferred refinement. All CPU-bound
Essentia WASM.

| Stage | File | Status |
|---|---|---|
| Base estimate (Percival) | `src/background/audio/tempo.ts` | live; fast path preprocesses to 16 kHz |
| Beat-evidence correction | `tempo-beat-correction.ts` + `tempo-correction-support.ts` | **live** (this is "Attempt 4 / Option 4") |
| Segment / sparse voting | `tempo-segment-prototype.ts` | **live** (was the "next prototype" in the old findings) |
| Deferred refinement | `src/background/handlers/analysis-tempo.ts`, `analysis.ts` | live; concurrent, not serial |
| Worker-pool parallelism | `audio/worker-pool.ts`, `analysis-worker.ts` | **live**; 3 workers default, warm-up at startup |
| Request flow (content→bg) | `src/content/analysis/tempo-request.ts` → `handlers/analysis-tempo.ts` | live |

Worker count: `resolveWorkerCount()` in `src/shared/concurrency.ts` = `clamp(hardwareConcurrency − 2, MIN, MAX)`,
default 3 when unknown. The service-worker path is **retained on purpose** as the canonical fallback
when the pool is unavailable — do not remove it without a parity proof (reliability, timing, debug).

---

## 2. The core problem

The base estimator is fast and stable but makes **metrical-interpretation** errors: it locks onto the
wrong rhythmic layer. Two directions:

- **Overshoot** — real `~120` reported as `160`, real `128` as `163`.
- **Under-read** — real `~120` reported as `85`; pulse-lock cases where real `~136` reads `~90`.

This is structured, not noise. Confidence alone does **not** identify a wrong BPM.

---

## 3. Correction families (current thresholds)

`resolveCorrectionMode()` in `tempo-correction-support.ts` classifies from **raw base BPM** first,
then runs only that family's allowed transforms. A track outside every band gets **no** correction.

| Mode | Entry band | Extra gate | Candidates tested |
|---|---|---|---|
| `high-overshoot` | base 150–170 | — | base, 3/4, 4/5 |
| `high-overread-nonclassic` | base 145–149 | — | base, 3/4, 4/5 |
| `low-ambiguous` | base 85–100 | confidence ≤ 40 | base, 5/4, rhythm |
| `mid-underread` | base 85–100 | — | base, 3/2, rhythm |
| `mid-drift` | base 120–140 | confidence ≤ 45 | base, rhythm |

The correction only overrides `base` when an alternative **clearly** wins on beat-evidence
(segment + sparse voting, family alignment) — weak/mixed evidence keeps base. `true-high-correct`
is **not** a mode: it is the protected outcome of a track entering `high-overshoot` and staying at base.

**Always classify and tune from raw `Base BPM`**, never from corrected/deferred output — corrected
output hides the real miss families (the WASM rebuild shifted the raw distribution; old ranges were
tuned to the old bands).

---

## 4. Failure classes (what each guardrail protects)

Condensed from the verified set. Keep representatives of each when retesting.

1. **False `160` with slower-family support** (e.g. *Quasar Winds*, *Modèle*) — easiest to correct.
2. **Wrong-pulse overshoot, weak alternative** (e.g. *Koyul*) — slower family doesn't win on score;
   the open hard case.
3. **Under-read** (e.g. *Kelpie* `85→120`) — opposite direction failure.
4. **Non-`120` overshoot** (e.g. *Cior* `163→128`) — corrections must not hard-code `160→120`.
5. **True-high controls** (*Trampolin*, *bluhol – Recondition*) — base is correct; must stay.
6. **True `160` near-ties** (*Vessel*, *Dark Green*, *Qi – Pythia*, *Bizoka*, *BLUME*, *HWA – 8xr*) —
   look like false `160` if the gate is loose; the reason the old exact-`160` fold-down was unsafe.
7. **Low-band provisional under-reads** that recover on deferred refinement — mostly a UX/provisional
   issue, not an exact-path bug.
8. **Low-band exact misses `~131–140`** (e.g. *Ina Kacz*, *Local Analyst*) — drove the low-band
   recovery fix + `131` bridge.
9. **Low-band false promotion** (`base ~85 + rhythm ~113` that is genuinely `85`) — the counterexample
   that blocks any naive widening of the low-band gate.
10. **Low-band pulse-lock** (real `~136` → `~90`, whole stack agrees on the wrong pulse) — cannot be
    fixed by a threshold tweak; left conservative.

---

## 5. Guardrails — do not regress

- **Protect true high-BPM tracks.** Any change that improves false-`160` but breaks a true-`160`
  control is **rejected**, full stop.
- **No broad heuristics / fuzzy windows.** Use exact anchored ratio candidates; broad ±BPM windows
  let different ratio labels collapse onto the same BPM (this caused Attempt 3's regressions).
- **Classify from raw base BPM**, agree the raw-family map *before* touching thresholds, and only add
  a new family if repeated raw misses can't be explained by existing ones. Do not bolt per-track
  exceptions into runtime scoring.
- **One stage owns one job.** BPM and key are separate pipelines with separate caches/status; enabling
  key must never restart settled BPM, and a settled BPM view must not drop back to a generic loading
  state. `empty` is a valid completed key result.
- **Confidence for ambiguous modes** = min(raw detector confidence, decision-gate confidence) — don't
  surface raw Essentia confidence alone for `high-overshoot` / `low-ambiguous`.
- **Sign-off needs the full curated set**, not family-specific spot checks. Minimum: 5 false-`160`,
  5 true-`160`, 3 under-reads.

---

## 6. Rejected attempts — do not revive without contradicting evidence

- **Attempt 1 — more same-family evidence + scoring layer:** slower, same wrong BPMs (measured the
  same interpretation N ways). Rejected.
- **Attempt 2 — grid-fit/onset correction:** no gain, one `160→80` regression. Rejected.
- **Attempt 3 — loose ratio corrector:** improved some false-`160` but forced true-`160` down
  (*Trampolin* `160→120`). Rejected. Candidate search too loose.
- **Exact-`160` family fold-down rule:** caused class-6 true-`160` regressions. **Removed.**
- **Attempt 4 — narrow beat-evidence correction (full-rate rhythm, exact candidates, conservative
  override):** **this is the current live design** (§1, §3). Kept because it is narrow and guarded.
- **Model-based tempo replacement (CNN / downbeat-first):** higher ceiling but too big while the
  regression set is small. Parked as a later refactor, not the next step.

---

## 7. Seek crackle history (resolved, kept)

From the old `tempo-seek-experiments.md`: non-tempo native seeks (`audio.currentTime`) clicked while
playing. Fix that stuck: route a running, neutral-tempo seek through the runtime path **when a
prepared runtime track exists**, plus latest-wins coalescing of runtime seek bursts. Discover routes
through the shared controller too. Details and constants now live in `rules/audio-rules.md` §4–5.

---

## 8. Verification

- Code health: `npx tsc --noEmit`, `npm run check:module-lines`, `git diff --check`.
- Build both targets (shared analysis path): `npm run build` (Firefox), `npm run build:chrome`.
- Accuracy: re-run the **full curated regression set** before calling any BPM change stable; reject on
  any true-high regression.
- Debug: tempo decision must be visible in the Step 3 panel (`Alt+D`) without reading source —
  base BPM, decision, candidates, e.g. `tempo-beat-correction base=160 rhythm=121 final=120
  label=3/4 reason=interval+grid`.

> Note: the old local harness (`scripts/check-bpm-*.js`, `bpm-regression-fixtures.json`) referenced in
> the deleted findings has been removed from the tree. The curated track set survives in §4 above; if
> the harness is wanted again, recover it from git history (pre-`b3c90bb6`).

---

## 9. The ~1 BPM offset vs rekordbox — beat-grid precision refinement (live)

**Symptom:** our integer BPM is often **1 off** rekordbox (e.g. true 137 shown as 136, true 138 as 139).

**Root cause (proven, not a rounding bug):** Percival's tempo output is quantised to a coarse lag grid —
every raw value is exactly `7500 / n` (`7500 = 60 × 16 kHz ÷ 128-sample hop`). In the 120–160 band the
grid steps are ~2–3.5 BPM, so a true integer tempo simply **cannot be expressed** and snaps to the nearest
lattice point, which rounds ±1. (Rekordbox is integer ~92% of the time in the 2137-track reference, so
"carry the decimal" was the wrong fix — confirmed in the data.) Tell-tale: many different tracks return
the identical `79.787` (= 7500/94).

**Fix:** `refineTempoToBeatGrid(baseBpm, fineBpm)` in `tempo.ts`. The finer beat-counter tempo
(`RhythmExtractor2013` aggregated `bpm`, **not** the raw interval median — that proved too noisy) replaces
the coarse base **only when it agrees with base within `GRID_REFINE_TOLERANCE_BPM = 1.25`** (half a grid
step → a same-pulse refinement, not a different-pulse jump). Applied in `resolveTempoForAnalysis`'s
*corrected* path, and **only when the octave is unchanged** (no correction, or correction kept base) — a
gross octave correction's value stands. The 1.25 gate is what keeps it safe: when the beat-counter is
wrong (e.g. it reported 69 = half-time on a 139 track) the disagreement is large, so base is preserved.

**Where it runs (both targets now one-shot corrected):**
- **Firefox: one-shot corrected (2026-06-09).** `analyzeTrackInternal` (`handlers/analysis.ts`) runs the
  `'corrected'` pass directly on first paint over **full** audio — no more base-only first paint + deferred
  `scheduleTempoRefinement` push. The user no longer sees a 136→137 flash; the analyzing state simply holds
  ~1.5–2 s longer, then shows the corrected BPM. This matches Chrome for **display parity** (explicit user
  request). `ANALYSIS_EXECUTION_OPTIONS.usePartialFetch` is `false` (the corrected pass needs the whole
  track), and applies to both the interactive current track and preload (and Discover, which shares the path).
  Cost: Firefox's first BPM is ~1.5–2 s slower — the accepted trade-off for parity. `scheduleTempoRefinement`
  is retained only for the legacy cached-"refining"-status upgrade path; the main path no longer schedules it,
  and `buildRefiningTempoStatus` is dead. The final BPM value is identical to what the old deferred pass
  produced (same `'corrected'` code), so this is a timing change, not an accuracy change.
- **Chrome: one-shot corrected.** The MV3 offscreen host is one-shot per track (no deferred stage; its
  cache feeds both the current track and preload), so `analysis-host.ts` runs `'corrected'` directly.
  This also **restored octave correction on Chrome**, which the base-only offscreen never applied.
  Cost: Chrome's first BPM is ~1.5–2 s slower (it waits for the beat-counter on every track).

**Validation:** measured in the BPM prototype panel against the rekordbox set with
`npm run check:bpm-offset -- <report.txt> [~/essentia-wasm-build/rekordbox-reference.jsonl]`
(`tools/check-bpm-offset.mjs` scores FIXED vs BROKEN on uncorrected tracks). At tol 1.25: **6 fixed,
0 broken** on the curated set; Holden Federico — *Origin [SK11X038]* confirmed **4/4** live on Firefox and
Chrome (Crux 137, Hemisphere 137, Sustained Light 138, Origin 139). The panel is **Firefox-only**
(`handleAnalyzeBpmPrototype` is `chrome-…-not-yet-wired`).

**RhythmExtractor2013 runs on the worker pool.** `extractRhythmEvidence` (`tempo.ts`) dispatches the
44.1 kHz beat-extraction to `worker-pool.ts` `extractRhythm` (job `extract-rhythm` in `analysis-worker.ts`),
with a main-thread fallback when no pool is ready. **Why:** it is the only essentia call in the corrected
path that doesn't already use the pool, so once Chrome ran `'corrected'` for every preload track it
serialised ~2 s rhythm passes on the offscreen main thread and backed long playlists up past the 15 s
preload budget (`preload-timeout:15000`). Offloading it parallelises across workers — verified: an 8-track
wishlist loaded 8/8 on attempt 1, no timeouts. **Guardrail:** do not move rhythm back to the main thread,
and keep returning the full `{bpm, confidence, ticks, estimates, bpmIntervals}` — octave correction needs
the intervals/estimates/ticks, not just `bpm` (the gate's `support=rhythm+interval+estimate+ticks` proves
the worker vectors arrive intact).

**Open item — Chrome first-BPM delay.** The one-shot trades ~1.5–2 s of first-paint latency for
correctness. If that proves unacceptable, the deferred+push design is the alternative but is **not lean on
Chrome**: it needs offscreen-cache rework + a new offscreen→background→tab push channel (tabId tracking) +
preload-cache propagation. Parked pending a call on whether the delay is tolerable.

**Debug:** the corrected `Tempo decision` carries `grid-refine fine=<x> agreed=<0|1> applied=<bpm|0>`.
Instrumentation: `rawBpm` (pre-round float) rides `EssentiaTempoResult` → worker protocol →
`ResolvedTempoAnalysis` → `AnalysisResult`; panel shows `Base raw BPM` / `Refined BPM` / `Refined agreed`.

**Guardrail for future changes:** do not widen `GRID_REFINE_TOLERANCE_BPM` to "fix" more tracks — the
1.25 cut cleanly separated the 6 real fixes (beat-counter within ~0.95 of base) from the failures
(>1.5 away). A wider gate re-introduced a break (a correct 134 pushed to 135).
