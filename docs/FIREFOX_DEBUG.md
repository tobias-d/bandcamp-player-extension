# Firefox Debug Guide

## Temporary Add-on Reload Loop

1. Rebuild:
```bash
npm run build:firefox
```
2. Open `about:debugging#/runtime/this-firefox`
3. Remove old temporary add-on
4. Load `dist/manifest.json`
5. Click `Inspect` for the extension background script

## Expected Startup Logs

- `[Extension] Initializing Essentia BPM detector...`
- `[Essentia] WASM module initialized successfully`
- `[Extension] Essentia initialized successfully`
- `[Extension] Ready!`

## Common Errors

- `background.service_worker is currently disabled`
  - You loaded MV3 manifest in Firefox build lacking service worker support.
  - Build Firefox target and load `dist/manifest.json`.

- `call to Function() blocked by CSP`
  - Manifest CSP not applied (or old temp add-on still loaded).
  - Remove/re-add temp add-on after rebuild.

- `Cross-Origin Request Blocked ... bcbits.com`
  - Missing host permission for CDN URLs.
  - Ensure manifest has `*://*.bcbits.com/*`.

- `Essentia WASM module unavailable...`
  - Usually import shape mismatch or stale build.
  - Rebuild and re-add extension.

## Verify Analysis Execution

When analysis starts you should see:

- `[Essentia] Starting tempo analysis (method: percival)`
- `[Essentia] Analysis complete: <BPM> BPM (<ms>ms)`
