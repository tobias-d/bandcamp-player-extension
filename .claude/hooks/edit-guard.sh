#!/usr/bin/env bash
# PreToolUse (Edit|Write). Block edits to build output (dist/ — Firefox loads from
# dist/firefox, so hand-edits get blown away on the next build). When a manifest is edited,
# inject a non-blocking reminder of the load-bearing manifest rules.
set -u
input="$(cat)"
f="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
case "$f" in
  */dist/*)
    jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"dist/ is webpack build output (Firefox loads from dist/firefox). Edit src/ and rebuild instead of editing generated files."}}'
    exit 0;;
  */src/manifest*.json)
    jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"Manifest edit — load-bearing rules: Chrome stays MV3 / Firefox MV2; keep the broad *://*/album/* and *://*/track/* host permissions (required for custom-domain metadata); keep the bandcamp.com/download exclusion paired with the page-context.ts guard."}}'
    exit 0;;
esac
exit 0
