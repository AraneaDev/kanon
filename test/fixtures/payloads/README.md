# Payload fixtures

Payloads captured verbatim from a live Claude Code session, kept so the
normaliser is tested against what Claude Code actually sends rather than
against what Kanon assumes it sends.

## What the spike settled

Captured 2026-08-27 from a session in this repository.

- **Field names are confirmed.** `InstructionsLoaded` carries `file_path` and
  `load_reason`, as the documentation said it would.
- **There is a third field.** `memory_type` states Claude Code's own view of a
  file's scope. The only value seen so far is `User`. Kanon reads it as a
  cross-check on the origin it infers itself, and treats an unrecognised value
  as no claim at all rather than as a contradiction.
- **`load_reason` is an open vocabulary.** Alongside `session_start`, a second
  session recorded `compact`, so instruction files reload mid-session. Reasons
  are printed verbatim, so a new one costs nothing.

## Still open

- **`ConfigChange` has not been observed.** `config-change.json` is absent
  because no configuration change has been recorded yet. `normalise.ts` reads
  `config_source` and `changed_keys` from the documentation alone, and that
  half of the normaliser is still unconfirmed.
- **Hook ordering is unknown.** Whether `SessionStart` fires before or after
  the first `InstructionsLoaded` decides whether the session-start brief can
  describe the current session or must predict it. `hooks.json` now records
  `SessionStart` too, so the next session answers this.

## Files

- `instructions-loaded.json` — a real `InstructionsLoaded` payload. Used by
  `test/normalise.test.ts`. Re-capture it from `~/.kanon/sessions/*.jsonl` if
  Claude Code changes shape; the test is written to fail rather than adapt.
