---
description: Report which instruction files govern this session and where each came from
---

Run the Kanon report for the current session and show the user the output verbatim.

Use Bash to run:

```
bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" report --cwd "$PWD"
```

Claude Code does not hand a running session its own session id, so the
`--session` flag is deliberately omitted: the CLI falls back to the most
recently recorded session that was itself recorded from this repository (or
this directory, outside a repository). It will not fall back to a session
from a different repository, even a more recently active one, so running
`/kanon` from two repositories at once never mixes their reports up.

Print the result exactly as it comes back. Do not summarise it, reorder it, or
drop rows: the alignment carries meaning and a dropped row is the row that
mattered.

If the command prints `kanon: no recorded session found for <path>`, say
that plainly: no instruction loads have been recorded for this directory,
and Kanon only sees sessions started after it was installed.

If `bun` is not found, tell the user Kanon needs Bun 1.1 or newer and that the
raw event log is still being written to `~/.kanon/sessions/`.
