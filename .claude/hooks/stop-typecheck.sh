#!/usr/bin/env bash
# Stop hook. When src/ has uncommitted changes, run the project's primary correctness
# check — tsc --noEmit (no test framework) plus git diff --check. On failure, exit 2 with
# the errors on stderr so the turn is re-engaged instead of ending on a type/whitespace error.
set -u
proj="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$proj" || exit 0
[ -z "$(git status --porcelain -- src 2>/dev/null)" ] && exit 0
out="$(npx tsc --noEmit 2>&1 && git diff --check 2>&1)" && exit 0
printf '%s\n' "$out" >&2
exit 2
