import { stripControl } from './colour'
import { short } from './paths'
import type { Steered } from './steering'

/**
 * What Claude is told when it reads a flagged item, or '' for one with no
 * verdict.
 *
 * `gone` is an ask, timed for the moment of reliance: the brief named the
 * item at session start, but a Read is when Claude is about to act on it.
 * The ack command names the item exactly as the row shows it, root-relative,
 * `~/...` or absolute, because that is the spelling Claude has in hand and
 * `kanon ack` accepts all three. Every argument is quoted by ackCommand(),
 * as in the brief.
 *
 * `may-be-stale` is a one-line note and never an ask: commits after an item
 * was written make it worth a second look, not worth interrupting the user.
 *
 * The evidence quotes a name taken from a file Kanon did not write, so it is
 * stripped of control characters here, as the brief does.
 */
export function warning(item: Steered, root: string, cli: string): string {
  if (item.verdict === null) return ''
  const shown = short(item.path, root)
  const evidence = stripControl(item.verdict.evidence)
  if (item.verdict.level === 'may-be-stale') return `KANON  note: ${shown} may be stale: ${evidence}.`
  return (
    `KANON  ${shown} ${evidence}. Before relying on it, ask the user whether it still holds. ` +
    `If it does, run: ${ackCommand(cli, root, stripControl(shown))}`
  )
}

/**
 * One argument for `sh`, single-quoted. Inside single quotes nothing is
 * special but the quote itself, which is closed, escaped and reopened.
 * Double quotes were used first, and they still expand `$(...)` and
 * backticks: a cloned repository names its own rule files, and Claude is
 * told to run this command as printed.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** The `kanon ack` command line, every argument quoted for `sh`. Shared with the brief. */
export function ackCommand(cli: string, root: string, path: string): string {
  return `bun ${shellQuote(cli)} ack --cwd ${shellQuote(root)} ${shellQuote(path)}`
}
