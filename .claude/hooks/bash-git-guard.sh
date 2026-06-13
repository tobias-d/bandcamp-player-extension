#!/usr/bin/env bash
# PreToolUse (Bash). Two guards:
#  1. Hard-block any `git push` by the agent — the user pushes manually (! git push).
#  2. Block a `git commit` when the version is out of sync across package.json + the 3
#     manifests (the preflight build guard enforces this at build time; this catches it earlier).
# Normal commits are allowed — committing only happens when the user asks; no hook can know
# intent, so "never auto-commit" stays a behavioral rule, this just guards a half-done bump.
set -u
input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

# Match a git subcommand only at COMMAND POSITION — start of a line or right after a shell
# separator ( ; & | ( ), optionally through `git -C <path>`. grep is line-oriented, so ^/$ are
# per-line. This avoids false positives when "git push"/"git commit" merely appears inside a
# commit message or heredoc body (which is part of the command string the hook receives).
is_git_subcmd() {
  printf '%s' "$cmd" | grep -Eq "(^|[;&|(])[[:space:]]*git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?$1([[:space:]]|\$)"
}

if is_git_subcmd push; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Pushing is disabled for the agent. Push manually instead: run  ! git push  in the prompt."}}'
  exit 0
fi

if is_git_subcmd commit; then
  proj="$(cd "$(dirname "$0")/../.." && pwd)"
  cd "$proj" || exit 0
  v="$(jq -r .version package.json 2>/dev/null)"
  for m in src/manifest.json src/manifest.firefox.json src/manifest.firefox.dev.json; do
    mv="$(jq -r .version "$m" 2>/dev/null)"
    if [ "$mv" != "$v" ]; then
      jq -nc --arg msg "Version out of sync: package.json=$v but $m=$mv. Sync all four (package.json + 3 manifests) before committing." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$msg}}'
      exit 0
    fi
  done
fi
exit 0
