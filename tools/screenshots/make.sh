#!/usr/bin/env bash
# Regenerate the screenshots in assets/.
#
#   bash tools/screenshots/make.sh            every shot
#   bash tools/screenshots/make.sh report     just the report shot
#
# Every shot runs the real CLI against a planted repository. Nothing here
# starts a Claude Code session, spends a token, or makes a network request, so
# this is free to run as often as you like.
#
# Dependencies go in a virtualenv beside this script rather than in the system
# python, which on most distributions refuses the install anyway (PEP 668).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$here/.venv"

if [ ! -x "$venv/bin/python" ]; then
  echo "creating virtualenv in $venv"
  python3 -m venv "$venv"
  "$venv/bin/pip" install --quiet --upgrade pip
  "$venv/bin/pip" install --quiet -r "$here/requirements.txt"
fi

exec "$venv/bin/python" "$here/screenshots.py" "${1:-all}"
