#!/usr/bin/env bash
#
# The README makes claims about the code. This checks the ones that go stale
# silently. It has caught two real drifts already: a sample report showing an
# annotation the code cannot emit, and column offsets that did not match what
# render() actually prints.
#
# Run it from the repository root.

set -uo pipefail

status=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mDRIFT\033[0m %s\n' "$1"; status=1; }

echo "Checking README.md against the code"

# --- the ruleset stamp -------------------------------------------------------
code_ruleset=$(grep -oP "RULESET = '\K[^']+" src/types.ts)
if grep -q "ruleset ${code_ruleset}" README.md; then
  ok "ruleset ${code_ruleset} appears in the sample report"
else
  bad "src/types.ts says RULESET is '${code_ruleset}', the README's sample does not show it"
fi

# --- the test count badge ----------------------------------------------------
# A badge that quietly stops being true is worse than no badge.
actual_tests=$(bun test 2>&1 | grep -oE '^Ran [0-9]+ tests' | grep -oE '[0-9]+' | head -1)
badge_tests=$(grep -oP 'tests-\K[0-9]+' README.md | head -1)
if [ -z "$badge_tests" ]; then
  bad "no tests badge found in the README"
elif [ "$actual_tests" = "$badge_tests" ]; then
  ok "tests badge says ${badge_tests}, suite runs ${actual_tests}"
else
  bad "tests badge says ${badge_tests}, suite actually runs ${actual_tests}"
fi

# --- install commands name the real plugin -----------------------------------
plugin=$(jq -r .name .claude-plugin/plugin.json)
# The marketplace Kanon is published in. It used to be read from a sibling
# checkout of the old marketplace repository, which never resolved in CI: the
# sibling is not checked out there, so it always fell through to the literal
# below and only ever checked the fallback. Kanon now ships from the marketplace
# on aranea-development.nl, so the literal is the fact worth asserting.
market=aranea
if grep -q "plugin install ${plugin}@${market}" README.md; then
  ok "install command names ${plugin}@${market}"
else
  bad "README's install command does not match ${plugin}@${market}"
fi

# --- every origin the code can emit is documented ----------------------------
# If a new origin is added and never written down, users meet it first in a
# report they cannot interpret.
for origin in $(sed -n "s/^export type Origin =//p" src/types.ts | tr '|' '\n' | tr -d " '"); do
  case "$origin" in
    foreign) needle='FOREIGN' ;;
    *)       needle="$origin" ;;
  esac
  if grep -q "\`${needle}\`\|\*\*${needle}\*\*\|  ${needle} " README.md; then
    ok "origin '${origin}' is documented"
  else
    bad "origin '${origin}' exists in the code but is not in the README"
  fi
done

# --- the sample report is real ------------------------------------------------
# Every non-blank line of the fenced sample must be something render() could
# produce. Section headers are the cheap, high-value half of that.
for header in 'SESSION' 'LOADED' 'NOT LOADED'; do
  if grep -q "^${header}" README.md && grep -qF "${header}" src/render.ts; then
    ok "sample section ${header} exists in render.ts"
  elif grep -q "^${header}" README.md; then
    bad "README shows a '${header}' section that render.ts does not emit"
  fi
done

echo
if [ "$status" -eq 0 ]; then
  printf '\033[32mREADME matches the code\033[0m\n'
else
  printf '\033[31mREADME has drifted from the code\033[0m\n'
fi
exit "$status"
