#!/bin/sh
# Cold path. Emits the alarm, if any, as a ready-made systemMessage line.
#
# The CLI's --hook mode does its own JSON escaping with JSON.stringify and
# prints the finished `{"systemMessage": ...}` object, or nothing. This
# script never touches JSON itself: no second process spawned just to
# escape a string, and no printf/sed quoting that could hand Claude Code a
# malformed payload if it got a character wrong.
set -u
payload=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$sid" ] && exit 0
command -v bun >/dev/null 2>&1 || exit 0
bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" alarm --session "$sid" --cwd "${cwd:-$PWD}" --hook 2>/dev/null
exit 0
