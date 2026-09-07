---
description: Find which instruction file a directive came from, and what its origin is
argument-hint: "a phrase you remember from the rule"
allowed-tools: Bash(bun:*)
---

!`bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" whose "$ARGUMENTS" --cwd "$PWD"`

Print the output above exactly as it came back, in a fenced code block, and say
nothing else. The alignment carries meaning and a dropped row is the row that
mattered.

Matching is case-insensitive, and it runs over the file with runs of whitespace
collapsed, so a phrase that straddles a line break still matches. The quoted
line is the one where the match begins.

If the output says no file contains the phrase, do not go looking for it
yourself and do not guess where it came from. That answer is informative on its
own: either the directive reached this session from a surface Kanon does not
see yet, such as a skill, an MCP server or another plugin's hook, or it was
never in an instruction file at all. Say which files were searched and leave
the conclusion to the user.

The basis is stamped on the first line. `observed` means the search ran over
the files this session actually loaded. `predicted` means no recorded session
was found for this directory, so it searched the files Kanon expects to load,
which is layer two and can be wrong.
