#!/bin/sh
# Cold path. Renders the report, or leaves the raw log if it cannot.
set -u
# CLAUDE_PLUGIN_ROOT is set by Claude Code for a plugin hook, but `set -u`
# turns an unset one into an abort carrying a non-zero status, and it aborts
# before the `exit 0` at the foot of this file can run. That is precisely the
# "a hook must never fail a session" invariant these scripts exist to keep, so
# it is read defensively and the hook leaves quietly instead.
root=${CLAUDE_PLUGIN_ROOT:-}
[ -n "$root" ] || exit 0
payload=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$sid" ] && exit 0
command -v bun >/dev/null 2>&1 || exit 0
bun "$root/src/cli.ts" report --session "$sid" --cwd "${cwd:-$PWD}" >/dev/null 2>&1
exit 0
