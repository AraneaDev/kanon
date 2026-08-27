#!/bin/sh
# Cold path. Renders the report, or leaves the raw log if it cannot.
set -u
payload=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$sid" ] && exit 0
command -v bun >/dev/null 2>&1 || exit 0
bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" report --session "$sid" --cwd "${cwd:-$PWD}" >/dev/null 2>&1
exit 0
