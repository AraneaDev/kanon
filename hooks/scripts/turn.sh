#!/bin/sh
# Delivery edge for the mid-session notice.
#
# InstructionsLoaded is where a mid-session load is detected, but that event
# has no decision control: Claude Code discards its JSON output fields, so
# the hook that sees the load cannot tell anyone about it. UserPromptSubmit
# can, on both channels, so the notice is delivered here at the next turn
# boundary instead.
#
# This runs on every prompt and blocks model processing until it returns, so
# the guard below is load-bearing: unless the session log has grown since the
# last notice, this script does a wc and leaves. Bun is spawned only on the
# turns where an instruction file actually loaded.
#
# Kanon never blocks. This hook returns context or nothing, never a decision.
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
case "$sid" in
  */*|.*) exit 0 ;;
esac

home=${KANON_HOME:-$HOME/.kanon}
log="$home/sessions/$sid.jsonl"
[ -f "$log" ] || exit 0

lines=$(wc -l < "$log" 2>/dev/null) || exit 0
lines=$(printf '%s' "$lines" | tr -d ' ')
seen=0
[ -f "$home/state/$sid.turn" ] && seen=$(tr -d ' \n' < "$home/state/$sid.turn" 2>/dev/null)
[ -z "$seen" ] && seen=0
[ "$lines" = "$seen" ] && exit 0

command -v bun >/dev/null 2>&1 || exit 0
bun "$root/src/cli.ts" notice --session "$sid" --cwd "${cwd:-$PWD}" --hook 2>/dev/null
exit 0
