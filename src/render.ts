import { PLAIN, type Paint } from './colour'
import { short } from './paths'
import type { Classified, Report, Skipped } from './types'

// Column widths pinned to the worked example in the original design write-up
// (no longer kept in this repository): the tag and path fields are padded and
// then concatenated with no extra separator, so the reason/verdict column lands
// at a fixed offset regardless of tag or path length.
const TAG_WIDTH = 11
const PATH_WIDTH = 37

/**
 * Pad a value to a fixed column width, but never let it fuse into the next
 * column: a value that reaches or exceeds the width gets a single trailing
 * space instead of the usual padding, so there is always at least one space
 * of separation. Kanon's real paths routinely exceed PATH_WIDTH, so this is
 * the common case, not an edge case, for the path column.
 *
 * Every caller pads the *unstyled* string and applies paint to the result.
 * Padding a string that already carries escape sequences would count them
 * toward its length and collapse the pinned columns, so the order matters.
 */
function pad(value: string, width: number): string {
  return value.length < width ? value.padEnd(width) : `${value} `
}

/**
 * gitTracked is tri-state: true, false, or null when git could not answer
 * (e.g. the path is outside a repository). null must never be rendered as
 * "untracked" -- that would assert something git did not actually say -- so
 * it gets its own, honestly noncommittal, wording.
 */
function trackedNote(c: Classified): string {
  if (c.gitTracked === false) return 'untracked in this repo'
  if (c.gitTracked === true) return 'tracked in this repo'
  return 'tracked status unknown'
}

function loadedLine(c: Classified, root: string, paint: Paint): string {
  const tag = c.origin === 'foreign' ? 'FOREIGN' : c.origin
  const main = `  ${paint.origin(pad(tag, TAG_WIDTH), c.origin)}${paint.path(pad(short(c.path, root), PATH_WIDTH))}${paint.reason(c.reason)}`

  const notes: string[] = []
  if (c.viaImport) notes.push(`imported by ${short(c.viaImport, root)}`)
  if (c.origin === 'foreign') {
    // These two signals are only recorded for foreign loads (see origin.ts /
    // report.ts): a non-foreign file's git status isn't the point.
    notes.push(trackedNote(c))
    if (c.gitIgnored === true) notes.push('git-ignored')
  }

  return notes.length > 0 ? `${main}\n${' '.repeat(2 + TAG_WIDTH)}${paint.note(notes.join(', '))}` : main
}

/**
 * Only a `launch` candidate that never loaded is a fault ("missing"). An
 * on-demand or path-scoped candidate that never fired is just a fact about
 * this session, never a fault, so it must never share vocabulary with
 * "missing".
 */
function quietReason(label: string): string {
  switch (label) {
    case 'on-demand':
      return 'on-demand, not triggered'
    case 'path-scoped':
      return 'path-scoped, no match'
    default:
      return 'excluded by claudeMdExcludes'
  }
}

/** The short, scannable label for a skip, shown in the tag column. */
function skipTag(reason: Skipped['reason']): string {
  switch (reason) {
    case 'too-large':
      return 'too large'
    case 'unreadable':
      return 'unreadable'
    default:
      return 'missing target'
  }
}

/**
 * A plain explanation of why a file never became a candidate, addressed to
 * the reader directly: this section exists precisely because a silent skip
 * leaves the report looking complete when it isn't, so the wording has to
 * tell you what to do about it, not just name the failure.
 */
function skipDetail(reason: Skipped['reason']): string {
  switch (reason) {
    case 'too-large':
      return 'over 4 MiB, the same limit Claude Code applies. Split it or shrink it if you want it loaded.'
    case 'unreadable':
      return 'could not be read. Check that you have permission to read it.'
    default:
      return 'the file an @import points to does not exist. Check the path, or remove the import if it is stale.'
  }
}

function skipLine(s: Skipped, root: string, paint: Paint): string {
  const main = `  ${paint.tag(pad(skipTag(s.reason), TAG_WIDTH), 'skip')}${paint.path(short(s.path, root))}`
  // A broken import is only actionable if you know where it came from, so
  // the importer -- when Kanon has one -- is named alongside the reason.
  const detail = s.importer ? `${skipDetail(s.reason)} Imported by ${short(s.importer, root)}.` : skipDetail(s.reason)
  return `${main}\n${' '.repeat(2 + TAG_WIDTH)}${paint.note(detail)}`
}

/**
 * The fixed-column report a human reads.
 *
 * `paint` defaults to PLAIN, which is the identity, so the default output is
 * byte-for-byte what it has always been. Only `report`'s stdout, and only
 * when that is an interactive terminal, is rendered with COLOUR; the
 * persisted report file and the piped `/kanon` path both keep the default.
 * See src/colour.ts for why.
 */
export function render(report: Report, paint: Paint = PLAIN): string {
  const { root, ruleset } = report
  const out: string[] = []

  // The "ruleset" label is pinned to column 36 in the worked example; that
  // holds for any root length as long as at least one space separates it
  // from the root.
  const gap = Math.max(1, 27 - root.length)
  out.push(`${paint.heading('SESSION')}  ${paint.path(root)}${' '.repeat(gap)}${paint.note(`ruleset ${ruleset}`)}`)
  out.push('')

  out.push(paint.heading('LOADED'))
  if (report.loaded.length === 0) out.push(`  ${paint.note('nothing recorded')}`)
  for (const c of report.loaded) out.push(loadedLine(c, root, paint))

  if (report.missing.length > 0 || report.quiet.length > 0) {
    out.push('')
    out.push(paint.heading('NOT LOADED'))
    for (const c of report.missing) {
      out.push(`  ${paint.tag(pad('missing', TAG_WIDTH), 'missing')}${paint.path(pad(short(c.path, root), PATH_WIDTH))}${paint.reason('expected at launch')}`)
    }
    for (const c of report.quiet) {
      out.push(`  ${paint.tag(pad('quiet', TAG_WIDTH), 'quiet')}${paint.path(pad(short(c.path, root), PATH_WIDTH))}${paint.reason(quietReason(c.label))}`)
    }
  }

  if (report.config.length > 0) {
    out.push('')
    out.push(paint.heading('CONFIG CHANGED'))
    for (const e of report.config) {
      out.push(`  ${e.t.slice(11, 16)}  ${e.source}  ${paint.note(`(+${e.keys.length})`)}`)
    }
  }

  if (report.modelDisagrees.length > 0) {
    out.push('')
    out.push(paint.warning('NOTE  the reachability model disagrees with reality for:'))
    for (const p of report.modelDisagrees) out.push(`  ${paint.path(short(p, root))}`)
    out.push(`  ${paint.note('The NOT LOADED section is unreliable for this session.')}`)
  }

  if (report.originDisagrees.length > 0) {
    out.push('')
    // Separate from the reachability NOTE above on purpose: this one casts
    // doubt on an origin column, not on the NOT LOADED section.
    out.push(paint.warning('ORIGIN DISAGREEMENT'))
    for (const d of report.originDisagrees) {
      out.push(`  ${paint.path(pad(short(d.path, root), TAG_WIDTH + PATH_WIDTH - 2))}${paint.note(`Claude Code says ${d.claimed}, Kanon inferred ${d.inferred}`)}`)
    }
  }

  if (report.skipped.length > 0) {
    out.push('')
    out.push(paint.heading('COULD NOT READ'))
    for (const s of report.skipped) out.push(skipLine(s, root, paint))
  }

  return out.join('\n')
}
