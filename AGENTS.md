# Bandcamp Deck — Agent Guide

This file is the short operating guide. Detailed area rules live in the linked `rules.md`
files below. Read the relevant area file before changing that part of the project.

## Rule Keywords

| Keyword | Meaning |
|---------|---------|
| MUST | Required for this repo unless the user explicitly overrides it. |
| SHOULD | Strong default. Deviate only when the current task makes it clearly wrong. |
| MUST NOT | Forbidden unless the user explicitly asks for it and accepts the risk. |

## Agent Behavior

- Start with a short plan and checkpoints before substantial work.
- Inspect relevant files before changing code. Do not guess architecture.
- Identify whether the task affects Firefox, Chrome, both, build tooling, runtime audio, UI, metadata, docs, or another area.
- Treat user requests as working hypotheses: neither blindly accept them nor assume they are wrong. If a request is ambiguous, risky, or conflicts with repo context, ask focused questions to refine it before making changes.
- Explain choices for a beginner: define terms, say why, and name the relevant files.
- Preserve user changes. Never revert unrelated dirty work.
- Prefer clean, deterministic fixes over clever or fallback-heavy logic.
- Treat every change as a chance to simplify: reduce code when practical, keep files small, and suggest focused refactors when complexity is growing.
- Ask for debugger output before changing runtime behavior when current state matters.
- Verify with the required commands before calling code changes done.

## Scope Rules

- Firefox and Chrome are separate supported products with different manifests and runtime constraints.
- The build is complex and dependency-heavy. Before changing build scripts, manifests, generated assets, WASM, SignalSmith, runtime-host code, or shared webpack paths, identify the dependent steps that may be affected.
- No new dependencies unless explicitly approved.
- No breaking changes unless explicitly approved.
- Do not add silent fallbacks, speculative recovery paths, retries, random timing guesses, or "just in case" branches unless the product already depends on them or the user asks for them.
- Follow existing naming, imports, architecture, and file ownership before inventing a new pattern.

## Area Rules

- Runtime audio: read `rules/audio-rules.md` before changing playback, Tempo Adjust, runtime host, handoff, predecode, SignalSmith, or runtime debug behavior.
- BPM/tempo detection accuracy: read `rules/bpm-analysis-rules.md` before changing the tempo estimator, beat correction, segment voting, correction families/thresholds, or the analysis worker pool.
- Build, manifests, release, and verification: read `rules/build-rules.md`.
- Architecture, directory map, large files, and conventions: read `rules/architecture-rules.md`.
- Metadata, Tralbum, custom-domain permissions, and identity resolution: read `rules/metadata-rules.md`.
- Likes, wishlist/collection inventory sync, like-state, and collect/uncollect mutation: read `rules/wishlist-and-collection.md`.
- Playlist resolution/sorting/selection, preload, and analysis request routing: read `rules/playlist-rules.md`.
- Injected UI panel behavior: read `rules/ui-rules.md`.
- Debug panel and debugger behavior: read `rules/debugger-rules.md`.
- Welcome gate layout, slides, content rules, and update announcements: read `rules/welcome-gate-rules.md`.

## Verification

- Docs-only change: review the diff. Build is not required unless the docs change build commands, generated files, or release instructions.
- Shared source change: run `npm run build` and `npm run build:chrome`.
- Firefox-only behavior change: run `npm run build`, then check whether Chrome could regress. Run `npm run build:chrome` if shared code, shared assets, or shared types changed.
- Chrome-only behavior change: run `npm run build:chrome`, then check whether Firefox could regress. Run `npm run build` if shared code, shared assets, or shared types changed.
- Build, manifest, webpack, WASM, SignalSmith, runtime-host, or release change: run both production builds.
- Release prep: run `npm run release:all` unless the user explicitly wants one browser only.

## Runtime Audio Short Version

- Runtime playback is split between Bandcamp origin audio, detached playlist audio, and the extension runtime host.
- Preserve runtime handoff gating, Firefox chunked feed behavior, two-host ping-pong switching, runtime prep cache behavior, and Chrome-only Performance mode unless the task explicitly changes them.
- Prepared audio is not the same as runtime ownership. Preparation alone must not authorize a runtime takeover.
- Runtime/debug changes must keep debugger output accurate.
- The complete source of truth is `rules/audio-rules.md`.

## Build Notes

- Firefox production build: `npm run build`; output loads from `dist/firefox/`.
- Chrome production build: `npm run build:chrome`; output loads from `dist/chrome/`.
- Release package build: `npm run release:all`.
- Production builds run a dependency-sensitive chain: preflight guard, custom Essentia WASM copy, Essentia CSP patch, SignalSmith worklet generation, webpack, then emitted webpack CSP patch.
- Do not change one build step without checking the steps before and after it.

## Debugger

- The debug panel is always live when the content script is running.
- Ask for Copy All or specific named debug areas when runtime state matters.
- Give exact capture instructions: browser/page context, user action, debugger area, and whether the capture is needed before or after the change.
- Do not remove required diagnostic areas or anonymization behavior.

## Definition Of Done

- Requested change is complete.
- Solution is deterministic, lean, and consistent with local conventions.
- Firefox and Chrome impact was considered.
- Required verification passed, or the final response explains why it was not run.
- Docs were updated when architecture, workflow, build, or debugging behavior changed.
- Final summary explains what changed, why it is stable, and how to verify.
