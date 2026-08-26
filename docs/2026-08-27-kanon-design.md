# Kanon: design

*(κανών, the measuring rod from which "canon" comes)*

**Every rule governing this session, named, including the ones you thought
loaded and didn't.**

Status: design approved 2026-08-27. Not yet implemented.

---

## 1. The problem

Claude Code assembles a session's instructions from many places: a managed
policy file, `~/.claude/CLAUDE.md`, `~/.claude/rules/**`, every `CLAUDE.md`
and `CLAUDE.local.md` in the ancestor walk, project `.claude/rules/**`,
`@path` imports to a depth of four, and subdirectory files that load lazily
when the agent reads files near them.

Nothing reports what that assembly actually produced, why each piece was
included, or what was expected and absent.

Two consequences show up in practice.

**Instructions you wrote silently do not apply.** A rules file in the wrong
directory, an exclude glob that matched more than intended, or a
path-scoped rule whose glob never fired. The failure is invisible: the
session simply behaves as though the file were not there, because it is not.

**Instructions you did not write silently do apply.** Measured on this
machine: 54 `CLAUDE.md` and `CLAUDE.local.md` files under `/root`, and 32 of
them, 59%, sit inside `vendor/`, `node_modules/` or a package cache. They
carry real directives. The one shipped with `bun-types` opens with "Default
to using Bun instead of Node.js" and eight imperative rules. Subdirectory
files load on demand when the agent reads files in that directory, so
debugging a dependency is enough to pull a third party's instructions into
context.

Kanon answers both questions from one data model: a set of instruction
files, each with a load status and an origin.

## 2. Prior art, and what Kanon adds

`/context` lists the memory files loaded in the current session, and the
Claude Code documentation recommends the `InstructionsLoaded` hook for
logging "exactly which instruction files are loaded, when they load, and
why". Kanon productises that recommendation against a partial built-in.

What `/context` does not do, and Kanon does:

- classify each loaded file's **origin**, so a dependency's file is named as
  foreign rather than listed beside your own
- name what is **missing**, not only what is present
- show a **timeline** rather than a snapshot, so a lazy load twenty minutes
  into a session is visible
- keep a **record** on disk after the session ends

## 3. Scope

In scope: instruction files (`CLAUDE.md`, `CLAUDE.local.md`,
`.claude/rules/**/*.md`, managed policy, `@path` imports) and mid-session
configuration changes.

Out of scope: auto memory under `~/.claude/projects/<project>/memory/`,
skills, subagent definitions, MCP configuration, and the content of any
instruction file. Kanon reports which files reached context and where they
came from. It does not read them for meaning, score them, or detect
injection. Prior art already covers injection scanning of instruction files
and Kanon deliberately does not compete with it.

Kanon never blocks. `ConfigChange` can block and Kanon declines to.

## 4. Architecture

Three units with one job each, communicating through files.

| Unit | One job | Depends on | Language |
|---|---|---|---|
| Recorder | append one event line | nothing | POSIX shell |
| Prospector | enumerate candidate instruction files for a cwd and label each with the rule that would load it | filesystem, settings | Bun + TypeScript |
| Reporter | join events against candidates, classify origin, render | the other two's output | Bun + TypeScript |

Prospector and Reporter are pure functions of their inputs. Both are
testable against fixtures with no session running.

### Why the language split

`InstructionsLoaded` fires once per file at launch and again on every lazy
load. Measured on the target machine, a shell hook invocation costs about
1.2ms against roughly 30ms for Bun startup. The hot path must therefore be
shell. The Prospector walks trees, parses YAML frontmatter, expands globs
and resolves symlinks, which is work shell handles badly, so the cold path
is Bun.

This matches existing precedent in both directions: claude-timestamp is
shell for latency, Talanton and Nekyia are Bun.

### Hook wiring

| Hook | Matcher | Unit | Purpose |
|---|---|---|---|
| `SessionStart` | all | Prospector | resolve and store the candidate set once |
| `InstructionsLoaded` | all | Recorder | append one load event |
| `ConfigChange` | all sources | Recorder | append one config-change event |
| `SessionEnd` | all | Reporter | write the final report |

`InstructionsLoaded` cannot block and its exit code is ignored, so the
Recorder always exits 0. `ConfigChange` can block; Kanon does not.

## 5. Data

Append-only JSONL, one file per session, at
`~/.kanon/sessions/<session_id>.jsonl`:

```
{"t":"2026-08-27T00:31:04Z","ev":"session","cwd":"/root/aranea","candidates":11}
{"t":"2026-08-27T00:31:04Z","ev":"loaded","path":"/root/.claude/rules/schrijfstijl.md","reason":"session_start"}
{"t":"2026-08-27T00:44:19Z","ev":"loaded","path":"/root/Knossos-MCP/vendor/phpstan/CLAUDE.md","reason":"nested_traversal"}
{"t":"2026-08-27T00:52:03Z","ev":"config","source":"skills","keys":["skillOverrides"]}
```

The candidate set resolved at `SessionStart` is written separately to
`~/.kanon/state/<session_id>.json`, because it is a snapshot rather than an
event.

No SQLite. A session produces tens of events, and JSONL stays greppable
without a tool. An index is additive later if cross-session questions ever
matter.

Retention: Kanon writes only under `~/.kanon/` and never under
`~/.claude/`. Events, state and reports older than 90 days are pruned by
the Reporter on its next run.

## 6. Origin classification

Throughout this document the **session root** is the git repository root
containing the session's cwd, or the cwd itself when it is not inside a
repository. This matches how Claude Code derives its own per-project
directory, so a worktree and its main checkout share one root.

Every observed load is classified into exactly one origin, evaluated in this
order, first match winning:

| Origin | Test |
|---|---|
| `managed` | the managed policy path for the platform |
| `user` | resolves under `~/.claude/` |
| `foreign` | path contains a dependency directory segment, or resolves outside both the session root and `~/.claude/` |
| `local` | basename is `CLAUDE.local.md` |
| `project` | anything else under the session root |

Reaching a file through an `@path` import is **not** an origin. It is an
orthogonal flag, `via_import`, recorded with the importing file's path. A
file has exactly one origin and may additionally be marked as imported, so
an external import that the user approved is still classified `foreign`
while keeping the record of how it arrived.

Dependency directory segments: `node_modules`, `vendor`, `.bun`, `.venv`,
`site-packages`, `.cargo`, `.gradle`, `Pods`.

`foreign` is the alarm, and it is the highest-value output because it rests
on no loader modelling at all. It classifies something that demonstrably
happened.

Two corroborating signals are recorded alongside a `foreign` verdict, both
cheap and both advisory rather than decisive: whether `git check-ignore`
reports the file ignored, and whether `git ls-files` reports it tracked in
the session repository. An untracked or ignored instruction file is worth
naming.

Symlinks are resolved before classification, so a rules file symlinked from
outside the project is classified by its target.

## 7. Reachability

This is the only component that models Claude Code's loader, and it is
quarantined so its failure cannot corrupt the rest.

The Prospector enumerates candidates from the documented rules as of
2026-08:

1. the ancestor walk from cwd to the filesystem root, collecting `CLAUDE.md`,
   `CLAUDE.local.md` and `.claude/CLAUDE.md`
2. `~/.claude/CLAUDE.md` and `~/.claude/rules/**/*.md`, discovered recursively
3. the managed policy file for the platform
4. project `.claude/rules/**/*.md`, recursively, with symlinks resolved and
   cycles guarded
5. `CLAUDE.md` and `CLAUDE.local.md` in subdirectories below cwd, skipping
   dependency directories and anything git-ignored during the walk. A
   dependency directory is still classified and reported if a load is
   actually observed inside it, so skipping them bounds enumeration cost
   without hiding a foreign load
6. `@path` imports parsed from any launch-loaded file, to a depth of four
   hops, skipping Markdown code spans and fenced blocks, resolving relative
   paths against the importing file
7. subtract `claudeMdExcludes` globs, merged across every settings layer and
   matched against absolute paths

Each candidate carries one label:

| Label | Meaning |
|---|---|
| `launch` | expected in context at session start |
| `on-demand` | a subdirectory file, loads only if the agent reads files there |
| `path-scoped` | a rule with `paths:` frontmatter, loads only on a glob match |
| `excluded` | matched by `claudeMdExcludes` |
| `unreachable` | found on disk, and no documented rule loads it |

### Three rules that keep this honest

**Only `launch` candidates can be reported as MISSING.** An `on-demand` or
`path-scoped` candidate that never loaded is reported as "not triggered",
which is a fact about the session rather than a fault.

**The ruleset is version-stamped.** Every report carries
`ruleset: "2026-08"`. When Anthropic changes the loader, the stamp makes the
staleness visible instead of silent.

**The model self-checks.** If an observed load lands on a candidate labelled
`unreachable`, or on a path the Prospector never enumerated, Kanon reports
that its reachability model disagrees with reality and marks the affected
section unreliable for that session. It does not report the discrepancy as a
finding against the user.

Under that last rule, layer two degrades to "unknown" while origin
classification and the timeline keep working, which is the whole point of
the split.

## 8. Reporting surface

Quiet by default, and zero context cost. `InstructionsLoaded` can return
only `systemMessage` and `terminalSequence`, not `additionalContext`, so
Kanon's alarms reach the user and never the model. That is the correct
audience: the instruction set is the user's to fix.

Kanon speaks unprompted in exactly two cases:

- a `foreign` file loaded
- a `launch` candidate did not load

Everything else is available on request.

`/kanon` renders the session report:

```
SESSION  /root/Knossos-MCP          ruleset 2026-08

LOADED
  user       ~/.claude/rules/context7.md          session_start
  user       ~/.claude/rules/schrijfstijl.md      session_start
  project    CLAUDE.md                            session_start
  FOREIGN    vendor/phpstan/phpstan/CLAUDE.md     nested_traversal
             composer dependency, untracked in this repo

NOT LOADED
  missing    .claude/rules/testing.md             expected at launch
  quiet      docs/CLAUDE.md                       on-demand, not triggered
  quiet      .claude/rules/api.md                 path-scoped, no match

CONFIG CHANGED
  00:52  skills  (+1)
```

`SessionEnd` writes the same report to
`~/.kanon/reports/<session_id>.txt`.

## 9. Failure behaviour

The Recorder cannot break a session. `InstructionsLoaded` ignores exit
codes, so the worst outcome is a dropped line, and the Recorder exits 0
unconditionally.

If Bun is absent, the Recorder still logs and `/kanon` prints an install
hint rather than an error. Recording degrades gracefully to a raw event log
the user can read.

`SessionEnd` hooks share a 1.5 second budget across every hook configured
on the machine, raised only if a hook declares a longer timeout. The
Reporter therefore declares an explicit 5 second timeout and, if it cannot
finish, leaves the raw event log in place rather than a partial report. The
report can always be regenerated later with `/kanon`, so nothing is lost by
missing the budget.

Files larger than 4 MiB are skipped and noted, matching Claude Code's own
limit. Unreadable files are skipped and noted. Symlink cycles in rules
directories are guarded with a visited-inode set. A malformed hook payload
is written to the log verbatim under `{"ev":"unparsed"}` rather than
discarded, so a payload change is diagnosable from the record.

## 10. Testing

**Prospector**, against fixture directory trees, one per rule and one per
interaction worth pinning:

- an ancestor walk several levels deep
- a vendored `CLAUDE.md` inside `node_modules` and inside `vendor`
- a symlinked rules directory, and a symlink cycle
- imports at depth four, and at depth five, which must stop
- an import inside a fenced code block, which must not be followed
- a `claudeMdExcludes` glob merged across two settings layers
- a `paths:` rule with brace expansion
- a file over 4 MiB

**Reporter**, snapshot tests over fixture event logs paired with fixture
candidate sets, including the self-check path where an observed load
contradicts the model.

**Recorder**, fed captured real payloads, asserting the appended lines.

## 11. Open risk, and the first task

The `InstructionsLoaded` payload has not been confirmed empirically on this
Claude Code version. No transcript in the local corpus has the hook
registered, so only the documented field names are known: `file_path` and
`load_reason`. Every unit downstream depends on that shape.

The first implementation task is therefore a spike, not a feature: register
a logging hook, run one session, capture the real JSON, and pin it as the
Recorder's test fixture. If the field names differ, the design holds and
only the Recorder's extraction changes.

The second task is to confirm that `InstructionsLoaded` fires for lazily
loaded subdirectory files and not only at launch. The timeline in section 8
depends on it, and the documentation implies it without stating it.
