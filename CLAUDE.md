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
bun test                           # ~909 tests, all under test/
sh tools/mod-test.sh                # the pane mod tests, via claude plugin test
bun test test/render.test.ts       # one file
bun test -t "substring of a name"  # one test
bash tools/check-docs.sh           # asserts the README still matches the code
bash tools/screenshots/make.sh     # regenerates assets/*.webp from real CLI runs
```

Running the tool by hand (this is exactly what `/kanon:report` and the hooks do):

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

- `src/cli.ts` — entry point for all ten commands (`model --json` feeds the pane, `show` prints an item's text for its detail view), one `run*` function each; `main()` only prunes,
  resolves the session and dispatches. `report` prints and atomically writes
  `~/.kanon/reports/<id>.txt`; `alarm` prints a `{"systemMessage": ...}` object or nothing.
  `observedReport()` is the one place that decides whether `brief` and `whose` speak from
  observation or prediction, and `hookPayload()` the one place that builds the two-channel hook
  envelope.
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
  call the same file. `realPath` also lives here now, shared by `origin.ts`, `report.ts`, and
  `cli.ts`, so every path comparison in the codebase resolves the same way.
- `src/colour.ts` — the ANSI palette and, more importantly, the rule for when colour is allowed at
  all. `PLAIN` is the identity `Paint`, which is what keeps the piped and persisted output exactly
  the bytes it has always been.
- `src/audit.ts` — `kanon audit`: every file that could govern a session in this checkout,
  including the dependency tree discovery normally skips. No session needed.
- `src/whose.ts` — `kanon whose <phrase>`: where a literal string occurs in the governing files.
  Locates, never interprets.
- `src/transcript.ts` — reads the session transcript backwards to the start of the current run (4 MiB chunks, capped at 128 MiB) and scopes it to the
  current run: memories, hook injections, skills, compactions, and loads the hooks never saw.
  **The only file that names transcript fields.**
- `src/attribution.ts` — maps an injection back to the plugin whose `hooks.json` declared it.
- `src/names.ts` — `extractNames`: the paths, symbols, flags and scripts an item names, from
  inline code spans, `@imports` and path-shaped tokens, outside fenced code.
- `src/stale.ts` — `judge()`: turns names into a `gone` or `may-be-stale` verdict through a `Probe`.
- `src/probe.ts` — the real `Probe`: `lstat`, batched `git log`, one `git grep`, one `git ls-files`.
- `src/steering.ts` — everything that steers a session, with verdicts and acknowledgements; writes
  and reads the `<digest>.steer.json` cache.
- `src/warning.ts` — the text the Read hook returns for a flagged item.
- `src/notice.ts` — the mid-session notice for a foreign file that loaded after the brief.
- `src/drift.ts` — snapshot digests, `diff()` and `merge()`; what changed since the last session.
- `src/state.ts` — snapshots and watermarks under `~/.kanon/state/`, all flat regular files.
- `src/limits.ts` — the size ceiling (`tooLarge`) and `prune()`.
- `src/model.ts` — `paneModel()`, the data the pane draws, emitted by `kanon model --json` (version 2).
- `src/inventory.ts` — every hook, skill and agent memory a session can see, from settings files and
  enabled plugins, marked against the run's injections and invoked skills. Pure reads; a malformed
  file skips only itself. A plugin counts only when `enabledPlugins` sets it to true.
- `hooks/register.tsx` — the mod entry: registers `/kanon` (toggle the pane; print the report where
  nothing can draw) and the turn-end refresh.
- `hooks/mod/*` — the pane's side: `cli.ts` runs the CLI, `draw.tsx` draws, `port.ts`, `session.ts`
  and `state.ts` hold the runtime ports and view state.
- `hooks/lib/*` — layout, cards, rows, tiers, palette and text, copied from Knossos at a4412478 and
  trimmed; `control.ts` holds `stripControl`, copied from `src/colour.ts`.
- `tools/mod-test.sh` — stages the plugin without `test/` and runs `claude plugin test`.
- `src/atomic.ts` — write-then-rename, so a killed SessionEnd never leaves a truncated file.

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
- **The reason the `/kanon:report` fallback is scoped to the repository.** Claude Code does not hand a
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
  with `COLOUR`. The persisted `~/.kanon/reports/<id>.txt`, the `--hook` JSON and the `/kanon:report`
  path all stay plain — `/kanon:report` in particular pipes the report into a model's context, where an
  escape code costs a token and renders as garbage. Padding is always computed on the unstyled
  string and painted afterwards; invert that order and the pinned columns collapse.
- **The brief goes out on both `SessionStart` channels.** `systemMessage` is documented as
  "Plain-text message shown in the transcript. Not added to Claude's context; Claude never sees
  it", so shipping the brief on that alone addressed a document written for Claude to a reader
  that never got it. `hookSpecificOutput.additionalContext` is the half that reaches the model.
  Both carry the same string: a brief that said different things to the two readers would be the
  failure this tool exists to catch.
- **Everything under `~/.kanon/state/` is a flat regular file.** `prune()` skips anything that is
  not a regular file and never recurses, so a subdirectory there would never be swept and would
  grow without limit. A root cannot be a filename, so it is reduced to a digest and stored inside
  the file as well, which keeps the directory debuggable by hand.
- **A snapshot records observed loads, never candidates,** and an empty one is never committed.
  Drift built from predictions would inherit layer two's fallibility, and `files: []` from a
  session that recorded nothing would make every file in the next session read as `appeared`.
  `writeSnapshot` enforces the second rule; the first is the choice of `Report.loaded` as its
  input.
- **Session-start judging is bounded in time, and SessionEnd never judges.** A killed
  SessionStart hook prints no brief at all, losing even the FOREIGN alarm. So every git spawn in
  `src/probe.ts` has a timeout (2 s for grep, 1 s otherwise) and a timeout reads as unknown, never
  as `gone`; `steer()` takes a deadline (about 3 s, `KANON_JUDGE_BUDGET_MS` in tests) after which
  items are listed with a null verdict and still cached; and every item's code lookups go to git as
  one escaped `-E` alternation, because one grep per item, or even several pattern lines, cost
  seconds on a large repository. `report --commit-state` reads the steering cache or leaves STALE
  out; it never calls `steer()`, since its budget belongs to the report and the snapshot.
- **Only `SessionEnd` commits the snapshot.** `report --commit-state` is passed by
  `session-end.sh` and by nothing else. `/kanon:report` runs the same command mid-session, and a commit
  there would erase the baseline that report is describing.
- **Both sides of a drift comparison must be resolved, which is why `digest()` realpaths.** The
  observed side arrives already resolved, because `report.ts` realpaths every loaded path. The
  predicted side does not: `walkCandidates` only calls `resolve()`. Without the realpath in
  `digest()` the two sides name the same file differently whenever an instruction file is a
  symlink, and a `~/.claude/CLAUDE.md` symlinked into a dotfiles repository reads as `appeared`
  in every session, forever. This is the same invariant that keeps a false FOREIGN impossible,
  applied to drift.
- **`vanished` means absent from disk, on both bases.** `verified()` in `src/drift.ts` is the one
  place that narrows it, and `report.ts` and `cli.ts` both call it with `existsSync` injected so
  `diff()` stays pure. The gate once applied to the predicted basis only, on the argument that a
  file layer two stopped predicting has not left the canon. That argument holds identically for
  the observed basis: `Report.loaded` is what loaded *this session*, not the canon, so a nested
  CLAUDE.md in a subdirectory that a root-only session never triggered would otherwise be reported as
  deleted while sitting untouched in git.
- **The mid-session notice is printed before its watermark advances.** A crash between the two
  repeats an alarm; the reverse order would lose one. For an alarm a duplicate is the safe
  failure and silence is not.
- **The notice dedups by `load_reason`, not by bookkeeping.** `session_start` and `compact` are
  exactly the loads the brief already named, so suppressing those two is the whole mechanism. It
  is why no "already announced" set is persisted, and why a first turn with no watermark is safe.
- **`InstructionsLoaded` cannot speak.** It has no decision control and Claude Code discards its
  JSON output, which is why detection lives there and delivery lives in a `UserPromptSubmit`
  hook. That hook runs on every prompt, so its `wc -l` guard is load-bearing rather than an
  optimisation, and it must never return a `decision`.
- **Staleness is computed once, at session start, and only looked up on the hot path.** The brief
  judges every item and writes `<digest>.steer.json`; `read.sh` and `turn.sh` never run `git`.
  `report` reuses that cache when present, so it describes what Claude was told.
- **Only a missing path is `gone`.** A missing symbol, flag or script is `may-be-stale`. Claude
  Code's own config locations, slash commands, scheme-less URLs, globs, placeholders and ignored
  directories are never judged. A relative name is gone only when no tracked path matches it.
- **Tooling failure never produces `gone`.** `judge()` returns null when a probe throws, `exists()`
  answers true on any error but ENOENT, and a broken grep counts every name as found.
- **`may-be-stale` never makes Claude ask.** It is a report row and a one-line note on Read. Only
  `gone` goes in the brief and is raised at the moment of reliance. Under the brief's cap,
  missing < gone < FOREIGN, so a FOREIGN note never warns about a row Claude cannot see.
- **An acknowledgement lasts until the item or a file it names changes** (`namedDigests`).
- **Warn once per item per compaction epoch.** The epoch counts `compact` starts over the whole
  session log, not the current run, which restarts at each compact.
- **The Read hook never returns a decision.** It adds context or nothing, and `read.sh` bails in
  `sh` unless the path is in a memory directory and a steering cache exists.
- **`RULESET` in `src/types.ts`** stamps every report. Bump it when the model of Claude Code's
  loader changes, so a stale model is visible rather than silent.

- **The pane runs the CLI and never re-implements Kanon.** It gets its data from `kanon model --json`
  and reads nothing under `~/.kanon` itself.
- **The pane opens only by command.** Never from a hook, never remembered across sessions.
- **Layout is pure and width-swept.** `hooks/lib` layout does no I/O and reads no clock (the spinner
  frame is an input), and tests sweep widths across all three tiers.
- **Text Kanon did not write goes through `stripControl` before drawing,** never through `real`.
  The ack key is never stripped.
- **Mod tests run via `tools/mod-test.sh`, not `bun test`.** `bun test` is rooted at `test/` by
  `bunfig.toml`; `hooks/register.test.ts` needs `claude plugin test`. CI has no `claude` binary.

## Conventions

- Conventional Commits, enforced by release-please. `feat`, `fix`, `perf` and `refactor` show in the
  changelog and cut a release; `docs`, `test`, `ci`, `chore` and `style` are hidden and cut none. Do not hand-edit
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
- `test/fixtures/payloads/` and `test/fixtures/transcript/` hold records whose *structure* is
  captured verbatim from a live session: every field name, every field present. Their *values*
  are synthetic (`/home/user`, `example`, made-up ids), because the repository is public and a
  live payload carries home paths, session ids and the names of private files. When Claude
  Code's shape changes, re-capture from `~/.kanon/sessions/*.jsonl` (or the transcript) and
  replace the values again, rather than editing the fixture to match the code; the test is
  written to fail rather than adapt. Never commit a real path, session id, rule text or memory
  text.
