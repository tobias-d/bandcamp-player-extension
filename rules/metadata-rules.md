# Metadata, Identity, And Host Permission Rules

## Tralbum API Flow

`Tralbum` is Bandcamp's combined track-or-album data. Release metadata is API-first:

1. The content metadata extractor sends `FETCH_TRALBUM` to `src/background/handlers/tralbum/`.
2. The background fetcher tries `/api/mobile/24/tralbum_details`.
3. It then tries `/api/tralbum/2/info`.
4. It uses limited HTML fallback only when structured API data is missing.

Android app logs from April 24, 2026 showed `/api/mobile/26/tralbum_details`, but checked v26 responses matched the current v24 payload shape. Do not switch API versions without confirming a concrete metadata benefit.

## Custom-Domain Metadata

The broad `*://*/album/*` and `*://*/track/*` host permissions are intentional and load-bearing. Bandcamp releases can be served on a label or artist custom domain, such as `subsistrecords.com/album/...`, with no `bandcamp.com` in the host.

When the extension knows only a custom-domain release URL and has no numeric identity, the only way to get metadata is the background HTML fetch of that page through `src/background/handlers/tralbum/html-fallback.ts`. Removing broad host permissions silently breaks custom-domain metadata when the release is not already in the captured Discover payload.

This was verified on 2026-06-02: gating the fetch to Bandcamp hosts left Subsist custom-domain releases stuck on `loading` with repeated `html-fallback skipped: non-bandcamp-host`. The Web Store concern was the MV2-to-MV3 upgrade, not a justified broad host permission.

## Discover Identity Selection

`src/content/discover/metadata/hints.ts` trusts the playing track id over a release-url association. A stale or foreign hint can map the same custom-domain release URL to a different band or album, so a release-only hint is never used to lock identity.

When no track-matched hint exists, identity is left null. That lets the custom-domain HTML fetch resolve the correct page instead of locking onto a wrong album that the API returns empty for.

## Runtime And Security Boundaries

- Background playback-audio fetches are intentionally narrow.
- `src/background/handlers/playback-audio.ts` accepts only HTTPS Bandcamp/Bcbits hosts.
- It includes credentials only for requested `bandcamp.com/stream_redirect` URLs.
- Firefox no longer rewrites Bandcamp CSP headers.
- `src/targets/firefox/background/index.ts` should stay a thin runtime/router entry unless a future change explicitly re-approves `webRequest` CSP patching.

## Metadata Fix Map

| Problem | Look in |
|---------|---------|
| Metadata wrong on player pages | `src/content/metadata/extractor/index.ts`, then `extractor/fields.ts`, `extractor/track-artist.ts`. |
| Tralbum API or fallback wrong | `src/background/handlers/tralbum/`, especially API fetches and HTML fallback. |
| Discover metadata wrong | `src/content/discover/metadata/index.ts`, `metadata/normalize.ts`, `metadata/hints.ts`, `metadata/payload.ts`. |
| Custom-domain metadata stuck | Check the broad album/track host permissions, `html-fallback.ts`, and Discover identity locking. |
| Player appears on Bandcamp utility pages | Check manifest `exclude_matches` in all three manifests and the `/download` utility guard in `src/content/page-context.ts`. |

## Metadata Change Rules

- Prefer structured API data over DOM scraping when both are available.
- Do not add a fallback source unless there is a specific observed missing state and the debugger or payload confirms why the existing path is insufficient.
- If a metadata bug depends on runtime page state, ask for the relevant debugger copy before behavior changes.
- Preserve custom-domain behavior unless the user explicitly asks for a permission redesign and accepts the risk.
