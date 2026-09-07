import { short } from './paths'
import type { Classified, Origin } from './types'

/** Reads a file's text, or null when it cannot be read or is too large. */
export type Reader = (path: string) => string | null

export interface Match {
  path: string
  origin: Origin
  /** 1-indexed line where the match begins. */
  line: number
  /** That line, as written, trimmed of surrounding whitespace. */
  text: string
}

/**
 * Where a phrase occurs in the files governing a session.
 *
 * This locates a literal string. It forms no view of what the string means,
 * scores nothing and ranks nothing: matches come back in the order the files
 * were given, which is the origin order both renderers already use. That
 * keeps it on the same side of the line as the digest and the brief's quoted
 * first directive, rather than reading the file for meaning.
 *
 * Matching is case-insensitive and runs over the file with every run of
 * whitespace collapsed to one space. That is what makes it useful rather
 * than a grep: instruction files are hard-wrapped, so a phrase a reader
 * remembers as one sentence is usually split across a line break, and a
 * line-by-line search would miss exactly the phrases someone would type.
 *
 * `read` is injected so this stays pure and its tests need no temp directory;
 * cli.ts supplies the real reader, with the same size limit the rest of the
 * codebase applies.
 */
export function matches(files: Classified[], phrase: string, read: Reader): Match[] {
  const needle = collapse(phrase).toLowerCase()
  // An empty phrase would otherwise match at offset zero in every file,
  // which is a confident answer to a question nobody asked.
  if (needle.length === 0) return []

  const out: Match[] = []
  for (const f of files) {
    const text = read(f.path)
    if (text === null) continue

    const at = collapse(text).toLowerCase().indexOf(needle)
    if (at === -1) continue

    const line = lineOfCollapsedOffset(text, at)
    out.push({ path: f.path, origin: f.origin, line, text: (text.split('\n')[line - 1] ?? '').trim() })
  }
  return out
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Pinned to the report's own columns, so the two read as one tool. */
const TAG_WIDTH = 11
const PATH_WIDTH = 37

function pad(value: string, width: number): string {
  return value.length < width ? value.padEnd(width) : `${value} `
}

/**
 * The answer a human reads.
 *
 * The empty case is the one that teaches something, so it says how many
 * files it searched and names the surfaces Kanon cannot see. A phrase found
 * nowhere in the instruction set either arrived from a skill, an MCP server
 * or another plugin's hook, or was never in an instruction file at all, and
 * the reader needs to be able to tell those apart from a broken search.
 */
export function renderWhose(
  phrase: string,
  found: Match[],
  basis: 'observed' | 'predicted',
  root: string,
  searched: number,
): string {
  const out: string[] = [`WHOSE  "${phrase}"${' '.repeat(Math.max(1, 44 - phrase.length))}${basis}`]

  if (found.length === 0) {
    out.push('  no file governing this session contains that phrase')
    out.push(`  ${searched} file${searched === 1 ? '' : 's'} searched. A directive can also reach you from a skill, an MCP`)
    out.push('  server, or another plugin\'s hook, none of which Kanon sees yet.')
    return out.join('\n')
  }

  for (const m of found) {
    const tag = m.origin === 'foreign' ? 'FOREIGN' : m.origin
    out.push(`  ${pad(tag, TAG_WIDTH)}${pad(short(m.path, root), PATH_WIDTH)}line ${m.line}`)
    out.push(`${' '.repeat(2 + TAG_WIDTH)}"${m.text}"`)
  }
  return out.join('\n')
}

/**
 * The 1-indexed line holding the character that produced `offset` in the
 * collapsed text.
 *
 * Collapsing loses the mapping back to the original, so it is rebuilt by
 * walking the file once and counting how many collapsed characters each line
 * contributes. Leading whitespace on a line contributes nothing, because
 * `collapse` trims and folds it into the single space that joins lines.
 */
function lineOfCollapsedOffset(text: string, offset: number): number {
  const lines = text.split('\n')
  let seen = 0
  for (const [i, raw] of lines.entries()) {
    const piece = collapse(raw)
    if (piece.length === 0) continue
    // The space that joins this line to the previous one is part of the
    // collapsed text and has to be counted before the line's own characters.
    const start = seen === 0 ? 0 : seen + 1
    const end = start + piece.length
    if (offset < end) return i + 1
    seen = end
  }
  return lines.length
}
