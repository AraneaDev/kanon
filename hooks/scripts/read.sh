#!/bin/sh
# Delivery edge for the Read warning.
#
# PreToolUse on Read: when Claude is about to read a memory that names
# something gone, this is the moment of reliance the brief asked Claude to
# wait for, so the warning arrives with the Read rather than at session start.
#
# This runs before every Read, so the guards below are load-bearing. The
# first is a pattern match on the raw payload with no process spawned at all;
# then the path must sit in a memory directory, and a steering cache must
# exist for there to be anything to look up. Bun starts only when all three
# hold, and then it only reads that cache.
#
# Kanon never blocks. This hook returns context or nothing, never a decision:
# no permissionDecision, no deny, no ask.
set -u
# Read defensively: under `set -u` an unset variable aborts with a non-zero
# status before the `exit 0` at the foot of this file can run, and a hook must
# never fail a session.
root=${CLAUDE_PLUGIN_ROOT:-}
[ -n "$root" ] || exit 0
payload=$(cat 2>/dev/null) || exit 0
# The cheap bail: almost every Read is of something that is not a memory,
# and that is decided here without spawning sed.
case "$payload" in
  */memory/*.md*) ;;
  *) exit 0 ;;
esac
path=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
case "$path" in
  */memory/*.md) ;;
  *) exit 0 ;;
esac
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$sid" ] && exit 0
case "$sid" in
  */*|.*) exit 0 ;;
esac

home=${KANON_HOME:-${HOME:-}/.kanon}
# No cache means no session start has judged anything yet, so there is
# nothing for warn to find. An unmatched glob stays literal and fails -f.
cached=
for f in "$home"/state/*.steer.json; do
  if [ -f "$f" ]; then
    cached=1
    break
  fi
done
[ -n "$cached" ] || exit 0

command -v bun >/dev/null 2>&1 || exit 0
bun "$root/src/cli.ts" warn --session "$sid" --path "$path" --cwd "${cwd:-$PWD}" --hook 2>/dev/null
exit 0
