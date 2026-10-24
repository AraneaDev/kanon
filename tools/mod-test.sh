#!/bin/sh
# Runs the mod's tests (hooks/register.test.ts) under `claude plugin test`.
#
# `claude plugin test <dir>` takes the plugin root and runs every *.test.ts
# under it, and the bun suite in test/ cannot load there (it imports
# bun:test), so it would fail whatever the mod does. This stages the working
# tree, tracked files as they are on disk, uncommitted edits included (git
# archive would test HEAD instead), drops test/ from the stage, and runs the
# kit on that. The exit code is the kit's; the stage is removed on exit.
set -eu

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
claude=${CLAUDE_BIN:-claude}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# A signal exits (and so runs the EXIT trap) rather than letting the script go on.
trap 'exit 130' INT TERM

(cd "$root" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | tar -xf - -C "$stage"
rm -rf "$stage/test"

status=0
"$claude" plugin test "$stage" || status=$?
exit "$status"
