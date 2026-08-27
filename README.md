<div align="center">

# Kanon

**Every rule governing this session, named.**
**Including the ones you thought loaded and didn't.**

[![Release](https://img.shields.io/github/v/release/AraneaDev/kanon?label=release&include_prereleases)](https://github.com/AraneaDev/kanon/releases)
[![Tests](https://img.shields.io/badge/tests-135%20passing-2b8a3e)](test/)
[![License](https://img.shields.io/github/license/AraneaDev/kanon?label=license&color=yellow)](./LICENSE)
[![Language](https://img.shields.io/github/languages/top/AraneaDev/kanon)](https://github.com/AraneaDev/kanon)
[![Last commit](https://img.shields.io/github/last-commit/AraneaDev/kanon?label=last%20commit)](https://github.com/AraneaDev/kanon/commits/main)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)
[![Status](https://img.shields.io/badge/status-pre--release-orange)](#install)

</div>

---

> **Kanon** (κανών) is the measuring rod, the straight edge a craftsman lays against his work to
> see whether it is true. The word became "canon": the list of texts a community agreed to be
> bound by. This tool does the smaller version. It tells you which texts your session is actually
> bound by, rather than which ones you believe it is.

A Claude Code plugin. It records every instruction file that loads into a session, says where
each one came from, and names the ones you expected that never arrived.

A `CLAUDE.md` can reach your context from a lot of places: the project you are in, your own
`~/.claude` setup, a directory above you, a subdirectory Claude wandered into, an `@path` import
buried four hops deep, or a dependency that shipped one and never mentioned it. Claude Code loads
them all the same way and reports none of it. Kanon writes down what actually happened.

> **Status:** pre-release. Kanon is installable from source and from this repository, and the
> hook payload field names have not yet been confirmed against a live session. If they turn out
> different the failure is loud rather than silent: the report says nothing was recorded, and the
> raw log still holds the truth.

---

## What it does

- **Names every instruction file that loaded**, in the order it arrived, with the reason Claude
  Code gave for loading it.
- **Classifies where each one came from.** `user` for your own `~/.claude` standing instructions,
  `project` for the repository you are in, and `FOREIGN` for anything shipped inside a dependency
  directory or living outside both. A foreign file got a voice in your session without you
  choosing to give it one, and that is the highest-value thing Kanon can tell you.
- **Names what did not load.** A launch-time file that never arrived is reported as `missing`,
  which is a fault. A subdirectory or path-scoped rule that simply never triggered is reported as
  `quiet`, which is a fact about the session rather than a fault.
- **Admits when it is wrong.** Kanon models Claude Code's loader to work out what it expected. If
  a file loads that its model never predicted, it says so and marks its own NOT LOADED section
  unreliable, rather than blaming you.
- **Says what it could not read.** An instruction file over 4 MiB, one it could not open, or an
  `@path` import pointing at a file that does not exist, is listed rather than quietly dropped.
- **Stays quiet otherwise.** It speaks unprompted only when a foreign file loads or an expected
  one is missing. Everything else waits for you to ask.

```text
SESSION  /home/you/project           ruleset 2026-08

LOADED
  user       ~/.claude/rules/style.md             session_start
  project    CLAUDE.md                            session_start
  project    .claude/rules/style.md               session_start
  FOREIGN    vendor/phpstan/CLAUDE.md             nested_traversal
             untracked in this repo

NOT LOADED
  missing    .claude/rules/testing.md             expected at launch
  quiet      .claude/rules/api.md                 path-scoped, no match
  quiet      docs/CLAUDE.md                       on-demand, not triggered

CONFIG CHANGED
  06:58  skills  (+1)
```

That is a real run, not a mock-up.

## Requirements

[Bun](https://bun.sh/) 1.1 or newer, on the machine running Claude Code. Nothing else. Kanon makes
no network request of any kind, has no API key, sends no telemetry, and never blocks a session.

## Install

```bash
claude plugin marketplace add AraneaDev/aranea-claude-tools
claude plugin install kanon@aranea-claude-tools
```

Hooks bind when a session starts, so start a new session before Kanon sees anything. It only sees
sessions that began after it was installed, and there is no way to reconstruct what happened
before that.

## The `/kanon` command

`/kanon` prints the report for the current session.

With no arguments it picks the most recent session recorded from the repository you are in. It
will not fall back to a session from a different repository, because reporting one repository's
loads against another's expectations invents alarms that are not real. If nothing was recorded
for the directory you are in, it says so plainly.

## Where the data lives

Everything sits under `~/.kanon/`, and Kanon never writes anywhere else. It reads `~/.claude/` and
never writes to it.

| Path | What is in it |
| --- | --- |
| `~/.kanon/sessions/<id>.jsonl` | One append-only line per hook event, raw |
| `~/.kanon/reports/<id>.txt` | The rendered report, written when the session ends |

Records older than 90 days are pruned on the next run. Point `KANON_HOME` somewhere else if you
want the data to live elsewhere.

## The ruleset

Every report carries a `ruleset` stamp, currently `2026-08`. Kanon has to model how Claude Code
resolves instruction files in order to say what it expected, and that behaviour belongs to
Anthropic and can change. The stamp is there so a stale model is visible rather than silent.

If Kanon's expectations and reality disagree, it tells you and stops trusting its own NOT LOADED
section for that session. What it observed loading is never in doubt, because that half needs no
model at all.

## What Kanon does not do

It reports which files reached your context and where they came from. It does not read them for
meaning, score them, rank them, or scan them for prompt injection. Deciding whether a dependency's
instructions belong in your session is your call. Kanon's job is making sure you know they are
there.

It never blocks. `ConfigChange` can block a configuration change and Kanon declines to.

## Development

```bash
git clone https://github.com/AraneaDev/kanon.git
cd kanon
bun install
bun run check      # typecheck, then the full suite
```

The design and the implementation plan live in [`docs/`](docs/).

## License

MIT.
