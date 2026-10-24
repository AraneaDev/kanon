// Copied from Knossos-MCP hooks/lib/marks.ts at a4412478, trimmed to what Kanon's pane uses.
/**
 * Every glyph the pane uses to mean something, in one place: what it means,
 * the tone it is drawn in, and the word a card's legend gives it. A glyph has
 * one meaning across the whole pane. Colour only ever reinforces a glyph.
 * Box drawing and the scroll hints are drawing, not marks, and stay where
 * they are drawn. Knossos's families (severity, reach, kinds) are replaced by
 * Kanon's one: what a session's instruction file needs from the person.
 */
import { ACCENT, STATUS_COLOURS } from './palette'
import { grouped } from './text'
import type { Segment } from './types'

export type MarkTone = 'ok' | 'warn' | 'alert' | 'accent' | 'dim' | 'text'
export type Mark = { glyph: string; meaning: string; tone: MarkTone; legend: string; plural?: string }

const m = (glyph: string, meaning: string, tone: MarkTone, legend: string = meaning, plural?: string): Mark => ({ glyph, meaning, tone, legend, ...(plural === undefined ? {} : { plural }) })

/** What an item needs from the person: gone, may be stale, foreign, acknowledged, or nothing to say. */
export const MARK = {
  gone: m('▲', 'an expected file that never arrived', 'warn', 'gone'),
  stale: m('≈', 'it may be stale', 'warn', 'stale'),
  foreign: m('!', "a file from a dependency, not the project's own", 'alert', 'foreign'),
  acked: m('✓', 'acknowledged: the person said it still holds', 'dim', 'acknowledged'),
  none: m('◦', 'nothing to say', 'dim', 'quiet'),
} as const

/** The glyph in each card's title. Never a row mark, so a card's title cannot be read as an item's state. */
export const CARD_GLYPH = '◇'

const toned = (tone: MarkTone): Omit<Segment, 'text'> =>
  tone === 'dim' ? { dim: true } : tone === 'text' ? {} : tone === 'accent' ? { color: ACCENT } : { color: STATUS_COLOURS[tone] }

/** A mark as a segment in its tone, `trailing` after the glyph (a space when a column follows). */
export function mark(entry: Mark, trailing = ''): Segment {
  return { text: entry.glyph + trailing, ...toned(entry.tone) }
}

/**
 * A card's legend: each mark it shows with its count and word, in the order
 * given, those counted zero left out. A count given as `''` names the mark
 * alone (`◦ quiet`). Empty when nothing is left.
 */
export function legend(entries: ReadonlyArray<readonly [Mark, number | string]>): string {
  return entries
    .filter(([, count]) => count !== 0)
    .map(([entry, count]) => {
      if (count === '') return `${entry.glyph} ${entry.legend}`
      const word = count !== 1 && entry.plural !== undefined ? entry.plural : entry.legend
      return `${entry.glyph} ${typeof count === 'number' ? grouped(count) : count} ${word}`
    })
    .join(' · ')
}
