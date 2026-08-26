#!/bin/sh
# Kanon hot path. Runs on every InstructionsLoaded and ConfigChange.
# One job: append the payload. It must never fail a session, so every
# failure path ends in exit 0.
set -u

payload=$(cat 2>/dev/null) || payload=''
[ -z "$payload" ] && exit 0

dir="${KANON_HOME:-$HOME/.kanon}/sessions"
mkdir -p "$dir" 2>/dev/null || exit 0

# One narrow extraction: the session id names the file, so concurrent
# sessions never interleave writes. Anything unparseable goes to unknown.
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
case "$sid" in
  ''|*/*|.*) sid='unknown' ;;
esac

hook=$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$hook" ] && hook='unknown'

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts='1970-01-01T00:00:00Z'

# Check if payload looks like JSON object (starts with { after stripping leading whitespace)
payload_trimmed=$(printf '%s' "$payload" | sed 's/^[[:space:]]*//g')
if [ -n "$payload_trimmed" ] && [ "${payload_trimmed#\{}" != "$payload_trimmed" ]; then
  # Payload starts with {, treat as JSON object
  printf '{"t":"%s","hook":"%s","raw":%s}\n' "$ts" "$hook" "$payload" >> "$dir/$sid.jsonl" 2>/dev/null
else
  # Payload is not JSON, escape and use unparsed field
  escaped=$(printf '%s' "$payload" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | sed 's/	/\\t/g' | sed 's/\r/\\r/g' | sed ':a;N;$!ba;s/\n/\\n/g')
  printf '{"t":"%s","hook":"%s","raw":null,"unparsed":"%s"}\n' "$ts" "$hook" "$escaped" >> "$dir/$sid.jsonl" 2>/dev/null
fi

exit 0
