# Kanon

Kanon answers one question: which instruction files govern this Claude Code
session, and where did each one come from.

A CLAUDE.md file can arrive from a lot of places: your own project, your
`~/.claude` setup, a nested subdirectory, an `@path` import buried inside
another file, or a dependency you never meant to give a voice in your
session. Claude Code loads all of these the same way. Kanon tells them apart
and writes down what actually happened, not just what should have happened.

## What it reports

Every instruction file that loaded gets classified into an origin. Three of
them are the ones worth watching:

- **user** - under `~/.claude/`. Your own standing instructions.
- **project** - under the session's repository root. What the project itself
  asks for.
- **foreign** - a dependency directory (`node_modules`, `vendor`, `.venv`,
  and the like), or anywhere else outside both of the above. A foreign file
  loaded into your session without you choosing it, and Kanon treats that as
  the highest-value signal it can raise.

Two more origins exist for completeness: **managed**, the platform's policy
file, and **local**, a `CLAUDE.local.md`. Both are exact matches on where the
file lives, so there's nothing to watch for there.

Kanon also tracks the other direction: a launch-time file it expected to load
and never did. That's reported as **missing**. A subdirectory or path-scoped
rule that simply never triggered is reported separately, as **quiet**, since
that's a fact about the session rather than a fault.

## Installation

Kanon needs Bun 1.1 or newer on the machine running Claude Code. Install the
plugin the way you install any Claude Code plugin, then start a session as
usual. Kanon only sees sessions that started after it was installed; there's
no way to reconstruct history from before that.

## The `/kanon` command

Run `/kanon` at any point in a session to see the full report:

```
SESSION  /root/myproject            ruleset 2026-08

LOADED
  user       ~/.claude/rules/schrijfstijl.md      session_start
  project    CLAUDE.md                            session_start
  FOREIGN    vendor/phpstan/phpstan/CLAUDE.md     nested_traversal
             untracked in this repo

NOT LOADED
  missing    .claude/rules/testing.md             expected at launch
  quiet      docs/CLAUDE.md                       on-demand, not triggered
```

Kanon also speaks without being asked, but only for the two things worth
interrupting you for: a foreign file loading, and a launch-time file that
didn't. Everything else stays on request, and the alarm itself stays out of
the model's context; it reaches you, as a systemMessage, never the
conversation. The instruction set is yours to fix, not Claude's.

Claude Code doesn't hand a running session its own session id, so `/kanon`
can't just ask for one. It picks the most recently recorded session that was
itself recorded from your repository, and it will not fall back to a
session from a different one, even a more recently active one. Run two
Claude Code sessions in two different repositories at once and each one's
`/kanon` still reports on its own repository. Run it somewhere Kanon has
recorded nothing yet and it says so plainly instead of guessing.

## Where the data lives

Everything Kanon writes goes under `~/.kanon/`, never under `~/.claude/`.
That's a hard rule, not a convention: Kanon reads your Claude Code
configuration but never touches it.

- `~/.kanon/sessions/<session_id>.jsonl` - the raw, append-only event log.
- `~/.kanon/reports/<session_id>.txt` - the rendered report, written again
  at the end of every session.

Records older than 90 days are pruned automatically. Nothing here is synced,
uploaded, or read by anything other than Kanon itself.

## The ruleset

Every report is stamped with a ruleset version, currently `2026-08`. That
stamp names the version of Claude Code's own loading rules that Kanon's
model is built against. If Anthropic changes how instructions load, the
stamp is what tells you Kanon's picture might be out of date, rather than
letting it go stale silently. When Kanon's model of reachability disagrees
with what it actually observed loading, it says so plainly in the report
instead of quietly guessing.

## What Kanon doesn't do

Kanon never blocks a session. It has no opinion strong enough to be worth
the cost of stopping you, and it makes that trade deliberately: even the
hook wired for a moment that could block, `ConfigChange`, is one Kanon
declines to use that way.

Kanon makes no network calls, sends no telemetry, and asks for no API key.
Everything it does is a local file read and a local file write.
