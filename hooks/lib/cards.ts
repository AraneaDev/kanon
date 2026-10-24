// Copied from Knossos-MCP hooks/lib/cards.ts at a4412478, trimmed to what Kanon's pane uses.
/**
 * Cards and the two-column grid. Pure: sections in, rows out, every row
 * exactly as wide as the card it is in.
 *
 * Every group of the pane is a card, one style per {@link Tier}:
 *
 * - medium and wide: the title set into a rule across the card (with the
 *   group's note at its end), the rows two cells in;
 * - narrow: the same rule, the rows from the edge, so a narrow pane loses no
 *   column.
 *
 * No box closes around a card: the rule, the colour and the gap between
 * cards carry the structure. A group with nothing in it collapses to one
 * ruled line. A list cut short ends in an `n more ↓` line. Knossos's height
 * sizing, bare sections, diff rows, wheel scrolling and card icon table are
 * not copied.
 */
import { FAINT, HEADING, TITLE } from './palette'
import { CARD_GLYPH } from './marks'
import { clip, dimRow, rowWidth, segmentsWidth, tinted } from './rows'
import { cells, fit, spaces } from './text'
import type { Row, Segment } from './types'
import type { Tier } from './tiers'

/**
 * One card: its title (and a dim subtitle beside it), a note against the
 * right edge, and its rows. `glyph` is the small mark before the title, the
 * card glyph unless given. A section with no rows and an `empty` word
 * collapses to one line: its title and its note (or, without one, that word)
 * set into a rule (`── ◇ Rules ───── ✓ 0 ──`), at every tier.
 */
export type Section = {
  key: string
  title: string
  subtitle?: string
  note?: Segment[]
  body: Row[]
  glyph?: string
  empty?: string
}

/** The frame's ink: the faintest theme key, so the cards order the pane without competing with it. */
export const FRAME = FAINT
/** The columns between two cards side by side. */
export const GRID_GAP = 2
/** The fewest cells a title is cut to so that its card's note still shows. */
const TITLE_MIN = 10

/** The columns a card `width` wide leaves its rows at `tier`: the frame and its padding take four. */
export const cardInner = (width: number, tier: Tier): number => (tier === 'narrow' ? Math.max(1, width) : Math.max(1, width - 4))

/** The two columns of the wide grid: the left one (`split` of the width, half by default), then the right one, {@link GRID_GAP} apart. */
export function gridColumns(width: number, split = 0.5): [number, number] {
  const left = Math.floor((width - GRID_GAP) * split)
  return [left, width - GRID_GAP - left]
}

/**
 * A note as segments: what a card says against its right edge. Its figures
 * are drawn at full contrast and the words around them dim, so a note reads
 * by its numbers.
 */
export const noteOf = (text: string): Segment[] => figures(text)

/** `text` split into its figures (`7,878`, `50+`), in the text colour, and the dim words between them. */
export function figures(text: string): Segment[] {
  if (text === '') return []
  return text
    .split(/(\d[\d,]*\+?)/)
    .filter(part => part !== '')
    .map(part => (/^\d/.test(part) ? { text: part, color: HEADING } : { text: part, dim: true }))
}

/**
 * A card's top edge: the title in bold, after its glyph in Claude's orange
 * (and the subtitle, while it fits), set into a rule across the card, the
 * note before its end. As
 * the width shrinks the subtitle goes, then the note, then the title is cut.
 * No box closes around the card: the rule and the colour carry it.
 */
export function topRow(section: Section, width: number): Row {
  const lead = '── '
  const close = '──'
  const note = section.note ?? []
  const mark: Segment[] = [{ text: `${section.glyph ?? CARD_GLYPH} `, color: TITLE }]
  const build = (subtitle: boolean, withNote: boolean, titleWidth = cells(section.title)): Segment[] | null => {
    const title: Segment[] = [...mark, { text: fit(section.title, titleWidth).replace(/ …$/, '…'), bold: true, color: HEADING }, ...(subtitle && section.subtitle ? [{ text: ` · ${section.subtitle}`, dim: true }] : [])]
    const right: Segment[] = withNote && note.length > 0 ? [{ text: ' ' }, ...note, { text: ` ${close}`, color: FRAME }] : [{ text: close, color: FRAME }]
    const fill = width - cells(lead) - segmentsWidth(title) - 1 - segmentsWidth(right)
    if (fill < 1) return null
    return [{ text: lead, color: FRAME }, ...title, { text: ` ${'─'.repeat(fill)}`, color: FRAME }, ...right]
  }
  // The title may be cut for the note, down to a word's worth: the note is often the figure the card is about.
  const room = width - cells(lead) - 1 - segmentsWidth(mark) - (note.length > 0 ? segmentsWidth(note) + 1 + cells(close) + 2 : 0)
  const cut = room >= Math.min(TITLE_MIN, cells(section.title)) ? build(false, true, room) : null
  const segments = build(true, true) ?? build(false, true) ?? cut ?? build(false, false)
  if (segments !== null) return { key: `${section.key}-head`, segments }
  // Too narrow for the rule: the title alone, cut.
  return { key: `${section.key}-head`, segments: [{ text: fit(section.title, width), bold: true, color: HEADING }] }
}

/**
 * One body row of a card: two cells in, the row padded to the inner width,
 * two cells to the edge, where a box's sides once stood. A tinted row (the
 * marked one) carries its tint across the inner width and the cell either
 * side of it.
 */
function framedRow(row: Row, width: number): Row {
  const inner = width - 4
  const fitted = rowWidth(row) <= inner ? row.segments : clip(row.segments, inner)
  const filled: Segment[] = [{ text: ' ' }, ...fitted, { text: spaces(inner - segmentsWidth(fitted) + 1) }]
  return { ...row, segments: [{ text: ' ' }, ...(row.tint === undefined ? filled : tinted(filled, row.tint)), { text: ' ' }], inset: 2 }
}

/** A row of a frameless (narrow) card at `width`: cut to it, and a tinted row filled to it. */
function bareRow(row: Row, width: number): Row {
  const fitted = rowWidth(row) <= width ? row : { ...row, segments: clip(row.segments, width) }
  if (row.tint === undefined) return fitted
  const used = rowWidth(fitted)
  return { ...fitted, segments: tinted([...fitted.segments, ...(used < width ? [{ text: spaces(width - used) }] : [])], row.tint) }
}

/** A card's rows at `width`: its top edge, a blank row, its rows (framed where the tier frames them); or, with nothing in it, its one ruled line. */
export function cardRows(section: Section, width: number, tier: Tier): Row[] {
  if (section.body.length === 0 && section.empty !== undefined) {
    // Its note says how it stands when it has one (`✓ 0`); else the word.
    const note = section.note !== undefined && section.note.length > 0 ? section.note : [{ text: section.empty, dim: true }]
    return [topRow({ key: section.key, title: section.title, note, ...(section.glyph === undefined ? {} : { glyph: section.glyph }), body: [] }, width)]
  }
  // A blank row under the title, so the title stands apart from what it heads.
  const head = [topRow(section, width), ...(section.body.length > 0 ? [{ key: `${section.key}-under`, segments: [{ text: spaces(width) }] }] : [])]
  if (tier === 'narrow') return [...head, ...section.body.map(row => bareRow(row, width))]
  return [...head, ...section.body.map(row => framedRow(row, width))]
}

/** Cards stacked, each after a blank row. */
export function stackRows(sections: Section[], width: number, tier: Tier): Row[] {
  return sections.flatMap(section => [{ key: `gap-${section.key}`, segments: [{ text: ' ' }] }, ...cardRows(section, width, tier)])
}

/**
 * Two columns of rows side by side: the left padded to `leftWidth`, a gap,
 * then the right; the shorter column ends in blank space.
 */
export function besideRows(left: Row[], right: Row[], leftWidth: number, gap = GRID_GAP): Row[] {
  const out: Row[] = []
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i]
    const r = right[i]
    const used = segmentsWidth(l?.segments ?? [])
    const key = `${l?.key ?? `pad-l-${i}`}|${r?.key ?? `pad-r-${i}`}`
    const head = [...(l?.segments ?? []), { text: spaces(leftWidth - used + gap) }].filter(s => s.text !== '')
    out.push({ key, segments: [...head, ...(r?.segments ?? [])], split: head.length })
  }
  return out
}

/**
 * The first and one-past-last index of a list `length` long shown `limit` at
 * a time, the marked item (`selected`, local; -1 for none) kept inside.
 */
export function windowOf(length: number, limit: number, selected = -1): { start: number; end: number } {
  const n = Math.max(1, limit)
  if (length <= n) return { start: 0, end: length }
  const start = selected < n ? 0 : Math.min(selected - n + 1, length - n)
  return { start, end: start + n }
}

/** The line under a list cut to a window: how many are above and how many more below, or nothing when all show. */
export function moreRows(key: string, window: { start: number; end: number }, length: number, width: number): Row[] {
  const parts = [...(window.start > 0 ? [`${window.start} above ↑`] : []), ...(length > window.end ? [`${length - window.end} more ↓`] : [])]
  return parts.length === 0 ? [] : [dimRow(key, `   ${parts.join(' · ')}`, width)]
}
