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
 * `kanon ack` accepts all three. Every argument is quoted, as in the brief,
 * so a path with a space survives being run as printed.
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
    `If it does, run: bun "${cli}" ack --cwd "${root}" "${shown}"`
  )
}
