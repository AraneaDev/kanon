# Payload fixtures

Payloads captured from a live Claude Code session, kept so the normaliser is
tested against what Claude Code actually sends rather than against what Kanon
assumes it sends.

The structure is verbatim: every field name, every field present, nothing
added. The values are not. This repository is public, and a live payload
carries a home path, session ids and the names of private files and projects,
so each value is replaced by a synthetic one of the same type (`/home/user`,
`example`, made-up UUIDs) wherever it does not change what the test checks.

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

## ConfigChange, settled 2026-10-23

- **The documented field names were wrong.** Live `ConfigChange` payloads
  carry `source` (seen: `user_settings`, `skills`) and an optional
  `file_path`. Neither `config_source` nor `changed_keys` occurs. Until this
  fixture existed every config row rendered as `unknown  (+0)`.

## Still open

- **Hook ordering is unknown.** Whether `SessionStart` fires before or after
  the first `InstructionsLoaded` decides whether the session-start brief can
  describe the current session or must predict it. `hooks.json` now records
  `SessionStart` too, so the next session answers this.

## Files

- `instructions-loaded.json` — a real `InstructionsLoaded` payload. Used by
  `test/normalise.test.ts`. Re-capture it from `~/.kanon/sessions/*.jsonl` if
  Claude Code changes shape, then replace its values as described above; the
  test is written to fail rather than adapt.
- `config-change.json` — a real `ConfigChange` payload, `source: "skills"`.
  Used by `test/normalise.test.ts`, under the same re-capture rule.
