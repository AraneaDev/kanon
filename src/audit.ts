import { PLAIN, type Paint } from './colour'
import { short } from './paths'
import { RULESET, type Label, type Origin } from './types'

export interface AuditEntry {
  path: string
  origin: Origin
  /** How this file would load, never a claim that it did. */
  label: Label
}

/** Reads a file's first directive line, or null. Injected by cli.ts. */
export type Excerpt = (path: string) => string | null

/** Pinned to the report's own columns, so the two read as one tool. */
const TAG_WIDTH = 11
const PATH_WIDTH = 37

function pad(value: string, width: number): string {
  return value.length < width ? value.padEnd(width) : `${value} `
}

const ORIGIN_ORDER: Origin[] = ['foreign', 'managed', 'user', 'project', 'local']

/**
 * What could govern a session in this checkout, with no session required.
 *
 * The report can only describe files that actually loaded, so a dependency's
 * CLAUDE.md stays invisible until the day it speaks, which is the day it is
 * too late to be told. This is the answer to the question you have after a
 * clone or an install: what got a voice here, before it uses it.
 *
 * Foreign comes first because it is the row this exists to surface, and its
 * first directive is quoted for the same reason the brief quotes it: knowing
 * a dependency ships instructions matters far less than seeing what they
 * tell Claude to do.
 *
 * The second column is how a file *would* load. Nothing here has loaded, and
 * the wording must never imply otherwise: an on-demand file in a dependency
 * fires only if Claude reads something in that directory, and overstating
 * that would be the kind of confident-sounding guess this tool exists not to
 * make.
 *
 * `paint` defaults to the identity, so a piped audit stays byte-for-byte what
 * it has always been and nothing a model reads ever carries an escape code.
 * Only an interactive stdout is painted, matching the report. Padding is
 * computed on the unstyled string and painted afterwards; invert that order
 * and the pinned columns collapse.
 */
export function renderAudit(root: string, entries: AuditEntry[], excerpt: Excerpt, paint: Paint = PLAIN): string {
  const gap = Math.max(1, 27 - root.length)
  const out: string[] = [`${paint.heading('AUDIT')}  ${paint.path(root)}${' '.repeat(gap)}${paint.note(`ruleset ${RULESET}`)}`, '']

  if (entries.length === 0) {
    out.push(`  ${paint.note('no instruction files found in this checkout')}`)
    return out.join('\n')
  }

  const ordered = ORIGIN_ORDER.flatMap((o) => entries.filter((e) => e.origin === o))
  for (const e of ordered) {
    const tag = e.origin === 'foreign' ? 'FOREIGN' : e.origin
    out.push(`  ${paint.origin(pad(tag, TAG_WIDTH), e.origin)}${paint.path(pad(short(e.path, root), PATH_WIDTH))}${paint.reason(e.label)}`)
    if (e.origin === 'foreign') {
      const quote = excerpt(e.path)
      if (quote) out.push(`${' '.repeat(2 + TAG_WIDTH)}${paint.note(`"${quote}"`)}`)
    }
  }

  const foreign = entries.filter((e) => e.origin === 'foreign').length
  out.push('')
  const tally = foreign === 0 ? `nothing foreign, ${entries.length} in total` : `${foreign} foreign, ${entries.length} in total`
  out.push(`  ${foreign === 0 ? paint.note(tally) : paint.warning(tally)}`)
  return out.join('\n')
}
