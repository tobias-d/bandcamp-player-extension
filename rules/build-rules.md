# Build, Manifest, Release, And Verification Rules

**Scope:** build/dev/release commands, the production prebuild chain, manifests, and the
verification matrix for every change type. This is a **map** (where-to-look + guardrails), not a
rebuild narrative.

> Cross-links: the audio-asset build steps are detailed in `rules/audio-rules.md` §7; the broad
> host permissions in `rules/metadata-rules.md`; repository layout in `rules/architecture-rules.md`.

## Build Commands

Core verification commands:

| Command | Target | Output | Use when |
|---------|--------|--------|----------|
| `npm run build` | Firefox production | `dist/firefox/` | Default Firefox verification. This is the normal Firefox build command agents should use. |
| `npm run build:chrome` | Chrome production | `dist/chrome/` | Required Chrome verification for shared or Chrome-relevant changes. |

Development commands:

| Command | Target | Output | Use when |
|---------|--------|--------|----------|
| `npm run build:dev` | Firefox development | `dist/firefox/` | Firefox development debugging. |
| `npm run watch` | Firefox development watch | `dist/firefox/` | Local iterative Firefox development. |

Release commands:

| Command | Target | Output | Use when |
|---------|--------|--------|----------|
| `npm run release:firefox` | Firefox package | `releases/firefox/` | Firefox-only release prep. |
| `npm run release:chrome` | Chrome package | `releases/chrome/` | Chrome-only release prep. |
| `npm run release:all` | Firefox + Chrome packages | `releases/firefox/`, `releases/chrome/` | Full release prep. |

Alias note:

| Command | Meaning |
|---------|---------|
| `npm run build:firefox` | Explicit Firefox production build. Equivalent in intent to `npm run build`, but `npm run build` is the preferred default in this repo guide. |

Browser load paths:

| Browser | Load directory |
|---------|----------------|
| Firefox | `dist/firefox/` |
| Chrome | `dist/chrome/` |

## Current Build Status

| Fact | Current value |
|------|---------------|
| Package version | `3.6.4` |
| Last verified | `2026-06-24` |
| Verified commands | `npm run release:all` |
| Firefox production build | Passing |
| Chrome production build | Passing |
| Test suite | None configured |
| Primary verification | Build-time TypeScript through webpack, plus manual browser loading |
| Custom WASM source | `vendor/essentia-wasm-custom/` |

## Build Pipeline

Production prebuild chain:

| Order | Script | Purpose |
|-------|--------|---------|
| 1 | `tools/build/preflight-build-guard.js` | Verifies workspace shape, critical files, package version consistency, and browser-specific source manifest contracts. Chrome source MUST be MV3; Firefox source currently MUST be MV2 for the active release path. |
| 2 | `tools/build/copy-custom-essentia-wasm.js` | Installs the custom Essentia WASM build into `node_modules/essentia.js/dist/`. |
| 3 | `tools/build/patch-essentia-no-eval.js` | Removes Essentia runtime patterns that violate extension CSP by using dynamic code construction. |
| 4 | `tools/build/generate-signalsmith-worklet.js` | Generates the checked-in SignalSmith worklet asset used by Tempo Adjust. Applies fail-loud post-generation patches: branch-1 dead-code, `clearBuffers` (no discarded-PCM transfer), and #7 multi-chunk feeding-loop fix. Verify with `node tools/build/verify-signalsmith-worklet-feeding.js`. |
| 5 | `webpack --env target=<browser> --mode production` | Builds the selected browser output. |
| 6 | `tools/build/patch-webpack-no-eval.js <browser>` | Patches emitted runtime-host bundle code so the final extension avoids `eval`-like webpack runtime behavior. |

Do not change one build step without checking the steps before and after it. The build is dependency-heavy: broad compatibility wrappers, duplicated transforms, or environment-sensitive branches make failures harder to reason about.

## Release Packaging

| Step | Rule |
|------|------|
| `tools/build/capture-release.js <browser>` | MUST verify the built `dist/<browser>/manifest.json` before zipping. Chrome release output MUST have `manifest_version: 3`, `background.service_worker`, separated `host_permissions`, and MV3 `web_accessible_resources`. Firefox release output MUST have `manifest_version: 2`, `background.scripts`, `browser_specific_settings.gecko.id`, and `data_collection_permissions.required: ["none"]`. |
| Chrome package | MUST NOT contain a Firefox/MV2 manifest. Chrome's current extension platform requires manifest version 3. |
| Firefox package | MUST NOT contain the Chrome MV3 service-worker manifest while this repo's Firefox release path remains MV2. Firefox and Chrome are separate products; do not collapse the manifests without an explicit migration task. |

## Manifests

- Firefox production manifest: `src/manifest.firefox.json` (MV2).
- Firefox development manifest: `src/manifest.firefox.dev.json` (MV2).
- Chrome production manifest: `src/manifest.json` (MV3).
- All three exclude `bandcamp.com/download*`; keep that exclusion paired with the `content/page-context.ts` utility-path guard when changing match rules.
- The broad `*://*/album/*` and `*://*/track/*` host permissions are intentional. See `rules/metadata-rules.md` before changing them.

## Build Failure Triage

| Symptom | Inspect first |
|---------|---------------|
| Version mismatch | `tools/build/preflight-build-guard.js`, `package.json`, `src/manifest*.json` |
| Missing critical file | `tools/build/preflight-build-guard.js` output |
| Essentia copy or WASM failure | `vendor/essentia-wasm-custom/`, `tools/build/copy-custom-essentia-wasm.js` |
| `Function`, `eval`, or CSP failure | `tools/build/patch-essentia-no-eval.js`, `tools/build/patch-webpack-no-eval.js` |
| SignalSmith or Tempo Adjust build failure | `tools/build/generate-signalsmith-worklet.js`, `src/assets/vendor/signalsmith/` |
| Webpack parse or terser failure | The generated/copied asset named in the webpack error |

## Build Fix Rules

- Fix the exact failing step. Do not add environment-sensitive branches or broad fallback wrappers.
- Keep build fixes targeted. Do not duplicate transforms or add compatibility layers without a clear product need.
- Run both production builds after build-tooling changes.
- Update docs when build commands, outputs, release flow, or required verification changes.

## Verification Matrix

| Task type | Required verification |
|-----------|-----------------------|
| Docs-only change | Review rendered Markdown or diff. Build is not required unless the docs change build commands, generated files, or release instructions. |
| TypeScript/source change | Run `npm run build` and `npm run build:chrome`. |
| Firefox-targeted behavior change | Run `npm run build`, then check whether Chrome could regress. Run `npm run build:chrome` if shared code, shared assets, or shared types changed. |
| Chrome-targeted behavior change | Run `npm run build:chrome`, then check whether Firefox could regress. Run `npm run build` if shared code, shared assets, or shared types changed. |
| Shared module change | Run `npm run build` and `npm run build:chrome`. |
| Manifest, webpack, build script, WASM, SignalSmith, or runtime-host change | Run `npm run build` and `npm run build:chrome`. |
| Release prep | Run `npm run release:all` unless the user explicitly wants one browser only. |
| Manual browser validation requested | Build the relevant target first, then load Firefox from `dist/firefox/` or Chrome from `dist/chrome/`. |

## Cross-Browser Rules

- Firefox and Chrome have different manifests, background runtimes, and constraints.
- Prefer browser-targeted fixes, targeted guards, or explicit capability checks over shared behavior changes.
- If shared code must change, verify both browser outputs unless the task is truly docs-only.
- A browser bug is not done until the intended browser is fixed and the other browser has been checked for regressions.
