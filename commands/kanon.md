---
description: Report which instruction files govern this session and where each came from
---

Run the Kanon report for the current session and show the user the output verbatim.

Use Bash to run:

```
bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" report --cwd "$PWD"
```

Claude Code does not hand a running session its own session id, so the
`--session` flag is deliberately omitted: the CLI falls back to whichever
session file it last wrote to, which is this session unless another Claude
Code session on the same machine is also active right now.

Print the result exactly as it comes back. Do not summarise it, reorder it, or
drop rows: the alignment carries meaning and a dropped row is the row that
mattered.

If the command prints nothing, say that no instruction loads were recorded for
this session and that Kanon only sees sessions started after it was installed.

If `bun` is not found, tell the user Kanon needs Bun 1.1 or newer and that the
raw event log is still being written to `~/.kanon/sessions/`.
