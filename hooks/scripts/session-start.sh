#!/bin/sh
# Cold path. Emits the brief Claude reads at the start of a session: which
# instruction files govern it, which of them are foreign, and what the user
# expected that never arrived.
#
# Unlike the alarm this replaced, it always speaks. This hook can fire before
# the first InstructionsLoaded is recorded, in which case the CLI falls back
# to predicting the launch set and says so, rather than going silent.
#
# The CLI's --hook mode does its own JSON escaping with JSON.stringify and
# prints the finished object. This script never touches JSON itself: no
# second process spawned just to escape a string, and no printf/sed quoting
# that could hand Claude Code a malformed payload if it got a character wrong.
#
# That object carries the brief twice, on both of SessionStart's channels.
# `systemMessage` is shown in the transcript and, per the hook contract, is
# never added to Claude's context; `hookSpecificOutput.additionalContext` is
# the half that reaches the model. The brief is written for Claude, so
# emitting only the first would address it to a reader that never gets it.
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
bun "$root/src/cli.ts" brief --session "$sid" --cwd "${cwd:-$PWD}" --hook 2>/dev/null
exit 0
