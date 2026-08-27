import type { Origin } from './types'

/**
 * ANSI styling for the human-facing report, and the rule for when it is
 * allowed at all.
 *
 * Colour is applied only to `report`'s stdout, and only when that stdout is a
 * terminal a person is looking at. Every other thing Kanon writes stays
 * byte-for-byte plain, and each for its own reason:
 *
 *  - `/kanon` runs the CLI through Claude Code's Bash tool. The report is
 *    piped into a model's context and echoed back out as markdown, so escape
 *    codes there would cost tokens on the way in and render as literal
 *    garbage on the way out. Colour cannot reach a model; it can only
 *    degrade what one reads.
 *  - `~/.kanon/reports/<id>.txt` is a file that outlives the terminal that
 *    produced it, and is read back by whatever the user points at it.
 *  - `--hook` output is JSON a hook script prints verbatim, and the brief
 *    inside it is written for Claude rather than for a screen.
 *
 * The gate is therefore the standard one rather than a Kanon-specific
 * setting: an interactive stdout, `NO_COLOR` (https://no-color.org/) to turn
 * it off anyway, and `FORCE_COLOR` to turn it on without a terminal, which is
 * what the screenshot tooling in tools/screenshots/ uses.
 */

const ESC = '\x1b['
const RESET = `${ESC}0m`

const style = (code: string) => (s: string): string => `${ESC}${code}m${s}${RESET}`

const bold = style('1')
const dim = style('2')
const red = style('31')
const green = style('32')
const yellow = style('33')
const blue = style('34')
const magenta = style('35')
const cyan = style('36')
const boldRed = (s: string): string => `${ESC}1;31m${s}${RESET}`

/**
 * Decide whether to colour, from the environment rather than from a flag.
 *
 * `env` and `isTTY` are parameters rather than reads of the ambient process
 * so this is testable without mutating global state: a test that had to set
 * process.env.NO_COLOR would leak that into every test after it.
 */
export function colourEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  // An explicit off beats an explicit on, in both spellings, so that a user
  // who has switched colour off system-wide never has it forced back on by
  // an inherited FORCE_COLOR.
  if (env.FORCE_COLOR === '0') return false
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR) return true
  if (env.TERM === 'dumb') return false
  return isTTY
}

/**
 * The styling seams in the report, one per thing the reader is being told.
 *
 * A record of functions rather than colour constants because `render` has to
 * be able to do nothing at all: PLAIN below is the identity, which is what
 * keeps the piped and persisted output exactly the bytes it has always been.
 * Padding is always computed on the unstyled string and the result styled
 * afterwards, so the pinned column widths cannot be thrown out by an escape
 * sequence's length.
 */
export interface Paint {
  heading(s: string): string
  origin(s: string, origin: Origin): string
  /** A NOT LOADED or COULD NOT READ tag, coloured by how much it matters. */
  tag(s: string, kind: 'missing' | 'quiet' | 'skip'): string
  path(s: string): string
  reason(s: string): string
  /** A secondary line hanging under a row: an import, a git status, a skip detail. */
  note(s: string): string
  /** Kanon admitting its own model is wrong. */
  warning(s: string): string
}

export const PLAIN: Paint = {
  heading: (s) => s,
  origin: (s) => s,
  tag: (s) => s,
  path: (s) => s,
  reason: (s) => s,
  note: (s) => s,
  warning: (s) => s,
}

/**
 * Colour carries the same ranking the report's wording already does, so the
 * two can never disagree: FOREIGN is the one finding worth interrupting a
 * reader for and is the only thing in bold red; `missing` is a fault and is
 * yellow; `quiet` is a fact about the session rather than a fault, so it is
 * dimmed rather than highlighted. The reason column is Claude Code's word
 * and not Kanon's finding, so it recedes.
 */
const ORIGIN_COLOUR: Record<Origin, (s: string) => string> = {
  managed: magenta,
  user: cyan,
  project: green,
  local: blue,
  foreign: boldRed,
}

export const COLOUR: Paint = {
  heading: bold,
  origin: (s, origin) => ORIGIN_COLOUR[origin](s),
  tag: (s, kind) => (kind === 'quiet' ? dim(s) : yellow(s)),
  path: (s) => s,
  reason: dim,
  note: dim,
  warning: (s) => bold(yellow(s)),
}

/** The paint to use for a stream, given the environment. */
export function paintFor(
  env?: Record<string, string | undefined>,
  isTTY?: boolean,
): Paint {
  return colourEnabled(env, isTTY) ? COLOUR : PLAIN
}
