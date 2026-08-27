# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kanon is a Claude Code *plugin* (not a library, not an app). It hooks a session, records every
instruction file that loads, classifies where each came from, and names the ones that were
expected and never arrived. Runtime is Bun; there is no build step and nothing is compiled or
published to npm. `package.json` exists for the toolchain and the version stamp only.

## Commands

```bash
bun install
bun run check                      # typecheck + full suite; the gate before any commit
bun run typecheck                  # tsc --noEmit
bun test                           # ~247 tests, all under test/
bun test test/render.test.ts       # one file
bun test -t "substring of a name"  # one test
bash tools/check-docs.sh           # asserts the README still matches the code
bash tools/screenshots/make.sh     # regenerates assets/*.webp from real CLI runs
```

Running the tool by hand (this is exactly what `/kanon` and the hooks do):

```bash
bun src/cli.ts report --cwd "$PWD"                    # the human report for this repo's last session
bun src/cli.ts brief  --cwd "$PWD"                    # the Claude-facing session-start brief
bun src/cli.ts alarm  --session <id> --cwd <path> --hook
KANON_HOME=/tmp/k bun src/cli.ts report --cwd "$PWD"  # point the data dir somewhere disposable
```

CI additionally runs `shellcheck -s sh -S style hooks/scripts/*.sh` and asserts that every hook
script exits 0 on an empty payload, on garbage, and on a valid one. Match that locally before
touching `hooks/scripts/`.

## Architecture

Two layers, deliberately separated, and the separation is the design:

**Layer one, observation.** `hooks/scripts/record.sh` is the hot path. It runs on every
`InstructionsLoaded` and `ConfigChange` and does one thing: append the raw payload, wrapped as
`{t, hook, raw}`, to `~/.kanon/sessions/<session_id>.jsonl`. It parses nothing beyond
`session_id` and `hook_event_name`, with `sed`. This half needs no model of Claude Code and is
never in doubt.

**Layer two, prediction.** `src/discover/` reimplements Claude Code's instruction-file resolution
in order to say what *should* have loaded. This half can be wrong, and the code is built to admit
it: when a file loads that the model never predicted, `report.ts` records it in `modelDisagrees`
and `render.ts` marks the whole NOT LOADED section unreliable for that session. Layer one's
findings are never gated on layer two being right.

Flow: `cli.ts` reads the JSONL -> `normalise.ts` turns lines into `Event`s -> `discover()` builds
the `Candidate` set -> `report.ts` joins the two and classifies origins -> one of two renderers.
`render.ts` produces the fixed-column report a human reads. `brief.ts` produces the text Claude
reads at session start, which is a different document for a different reader, not a reformatting
of the same one.

### The modules

- `src/cli.ts` — entry point for both commands. `report` prints and atomically writes
  `~/.kanon/reports/<id>.txt`; `alarm` prints a `{"systemMessage": ...}` object or nothing.
- `src/normalise.ts` — **the only file that names Claude Code payload fields** (`file_path`,
  `load_reason`, `config_source`, `changed_keys`). If Anthropic renames one, this is a one-place
  edit. Keep it that way.
- `src/discover/walk.ts` — managed policy file, `~/.claude/CLAUDE.md`, and the ancestor walk.
- `src/discover/rules.ts` — `**/*.md` under both `rules/` directories; frontmatter with a `paths:`
  key makes a file `path-scoped` rather than `launch`.
- `src/discover/imports.ts` — the `@path` graph, breadth-first, four hops.
- `src/discover/excludes.ts` — `claudeMdExcludes` merged across the settings layers.
- `src/discover/index.ts` — merges the four sources. Excluded candidates are *relabelled*, never
  dropped, so the report can explain their absence.
- `src/origin.ts` — one origin per file, first match wins: `managed`, `user`, `foreign`, `local`,
  `project`.
- `src/render.ts` — fixed-column text output for a human. The widths are pinned constants and the
  tests assert exact output, so a width change is a test change.
- `src/brief.ts` — the session-start brief for Claude. Pure: it takes a `BriefInput` and an
  excerpt function, touches no filesystem, and `cli.ts` supplies both.
- `src/paths.ts` — `short()`, shared by both renderers so they can never disagree about what to
  call the same file.
- `src/colour.ts` — the ANSI palette and, more importantly, the rule for when colour is allowed at
  all. `PLAIN` is the identity `Paint`, which is what keeps the piped and persisted output exactly
  the bytes it has always been.

### Invariants worth knowing before you change anything

- **A hook must never fail a session.** Every path in `hooks/scripts/*.sh` ends in `exit 0`, and
  `cli.ts` wraps `main()` so `alarm` can never leak a stack trace into a `systemMessage`. CI
  enforces this.
- **A false FOREIGN is the worst output this tool has.** It accuses your own file of being a
  dependency's. This is why `sessionRoot()` resolves through `realpath` and why `report.ts`
  realpaths loaded paths before comparing: on macOS `/tmp` and `/var` are symlinks, and an
  unresolved root would make every project file look foreign. Any new path comparison has to keep
  both sides resolved. `test/tmp.ts` exists for the same reason: use `tmp()` in tests, never
  `mkdtempSync` directly.
- **The reason the `/kanon` fallback is scoped to the repository.** Claude Code does not hand a
  running session its own id, so with no `--session` the CLI picks the newest recorded session
  *whose own `cwd` resolves to this root*. Never relax that to "newest file": with two sessions
  open in two repos it would report one repo's loads against the other's expectations, inventing
  alarms. No match means no report, which is the correct answer.
- **`discover()` walks the import graph exactly once** and returns `importedBy` alongside the
  candidates. Do not call `resolveImports` again on the merged candidates: it skips its own seeds,
  so a second call always finds nothing, which is how `viaImport` was silently null once already.
- **Kanon writes only under `~/.kanon`** (or `KANON_HOME`), reads `~/.claude`, and makes no
  network request. `prune()` in `src/limits.ts` runs against a real home directory on every
  invocation and uses `lstat`, never `stat`, so a symlinked entry is never followed. Read its doc
  comment before editing it.
- **Prediction must never report a file as missing.** `SessionStart` fires *before* any
  `InstructionsLoaded` (confirmed from a live log, 2026-08-27), so the hook always takes the
  predicted path: `brief` falls back to `discover()` alone and labels itself `predicted`. The
  `observed` basis is reachable only by running the CLI by hand mid-session, which makes layer
  two's accuracy the whole quality of the brief. Nothing has loaded when the hook runs, so an
  absence is not evidence: calling every launch candidate missing would fire a full alarm on
  every clean session. `brief.ts` drops `missing` outright when the basis is `predicted`, and
  `cli.ts` treats an existing-but-empty event log as unobserved for the same reason.
- **The `memory_type` cross-check is a compatibility table, not a mapping.** `CLAIMED_ORIGINS` in
  `src/types.ts` lists which inferred origins each claim does *not* contradict. Claude Code has no
  concept of `foreign`, so `Project` has to stay compatible with it; making that pair a
  disagreement would put a note questioning Kanon's classification next to every genuine FOREIGN
  find, which is the most valuable thing the tool reports. An unrecognised claim is no claim.
  Only `User` is confirmed from a live payload.
- **`originDisagrees` and `modelDisagrees` are different admissions.** The first says a row in
  LOADED may name the wrong origin. The second says the NOT LOADED section cannot be trusted.
  Never let one feed the other.
- **Colour is a property of the terminal, never of the report.** `render()` takes a `Paint` that
  defaults to the identity, and only `report`'s stdout, only on an interactive TTY, is rendered
  with `COLOUR`. The persisted `~/.kanon/reports/<id>.txt`, the `--hook` JSON and the `/kanon`
  path all stay plain — `/kanon` in particular pipes the report into a model's context, where an
  escape code costs a token and renders as garbage. Padding is always computed on the unstyled
  string and painted afterwards; invert that order and the pinned columns collapse.
- **The brief goes out on both `SessionStart` channels.** `systemMessage` is documented as
  "Plain-text message shown in the transcript. Not added to Claude's context; Claude never sees
  it", so shipping the brief on that alone addressed a document written for Claude to a reader
  that never got it. `hookSpecificOutput.additionalContext` is the half that reaches the model.
  Both carry the same string: a brief that said different things to the two readers would be the
  failure this tool exists to catch.
- **`RULESET` in `src/types.ts`** stamps every report. Bump it when the model of Claude Code's
  loader changes, so a stale model is visible rather than silent.

## Conventions

- Conventional Commits, enforced by release-please. `feat`/`fix`/`perf`/`docs`/`test`/`ci`/
  `refactor` all show in the changelog; `chore` and `style` are hidden. Do not hand-edit
  `CHANGELOG.md`, `package.json`'s version, or `.claude-plugin/plugin.json`'s version: release-please
  keeps the last two in step and CI asserts they agree.
- The hook scripts are POSIX `sh`, not bash. `/bin/sh` is dash on Ubuntu and bash-in-posix-mode on
  macOS, and both run in CI.
- Comments in this codebase explain *why*, usually the failure that motivated the line. When you
  change guarded behaviour, update the reasoning rather than deleting it.
- The README makes checkable claims about the code, including the test-count badge and the list of
  origins. `tools/check-docs.sh` and the `docs` CI job fail when they drift, so a change that adds
  an origin or moves the test count is a README change too. The sample report is labelled a real
  run: do not add a row to it that `render.ts` could not emit (a path appears at most once, under
  the first reason seen).
- `test/fixtures/payloads/` holds payloads captured verbatim from a live session. When Claude
  Code's payload shape changes, re-capture from `~/.kanon/sessions/*.jsonl` rather than editing
  the fixture to match the code; the test is written to fail rather than adapt.
