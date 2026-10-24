// Copied from Knossos-MCP hooks/lib/rows.ts at a4412478, trimmed to what Kanon's pane uses.
/**
 * The rows the pane builds: measuring them, pressable and tinted segments,
 * laying segments out across a width, and cutting them to it. Pure; nothing
 * here reads state. Text is measured and cut in `text.ts`. Knossos's diff
 * heights, hotkey label helper, group wrapping and list-end rows are not
 * copied.
 */
import { ACCENT, SELECTED_BG } from './palette'
import { cells, fit, spaces } from './text'
import type { Action, Row, Segment } from './types'

export const rowWidth = (row: Row): number => row.segments.reduce((n, s) => n + cells(s.text), 0)
export const segmentsWidth = (segments: Segment[]): number => segments.reduce((n, s) => n + cells(s.text), 0)

/** A pressable segment; its text is what the terminal draws for it, `hotkey: label` when it has a hotkey. */
export function button(action: Action, label: string, hotkey?: string, style: Omit<Segment, 'text' | 'press' | 'hotkey'> = {}): Segment {
  if (hotkey === undefined) return { ...style, text: label, press: action }
  return { ...style, text: `${hotkey}: ${label}`, press: action, hotkey }
}

/** `segments` with `bg` laid under each that has none of its own. */
export const tinted = (segments: Segment[], bg: string): Segment[] => segments.map(s => (s.bg === undefined ? { ...s, bg } : s))

/**
 * A row of `segments`, laid on `bg` (the marked row's ground unless another
 * is named) and carrying it as its tint when `on`, as it is otherwise.
 * `columns`, when given, pads a tinted row out to that width first, so the
 * ground runs to the pane's edge.
 */
export function tintedRow(key: string, segments: Segment[], on: boolean, { bg = SELECTED_BG, columns }: { bg?: string; columns?: number } = {}): Row {
  if (!on) return { key, segments }
  const used = segmentsWidth(segments)
  const padded = columns !== undefined && used < columns ? [...segments, { text: spaces(columns - used) }] : segments
  return { key, segments: tinted(padded, bg), tint: bg }
}

/** A row of a list the marker walks: `›` when marked, then `segments`, cut to `columns`, tinted to the edge when marked. */
export function walkedRow(key: string, marked: boolean, segments: Segment[], columns: number): Row {
  return tintedRow(key, clip([{ text: marked ? '›' : ' ', color: ACCENT, bold: true }, ...segments], columns), marked, { columns })
}

/** Segments laid out as `left`, a gap, then `right` against the right edge; `right` goes first when both do not fit. */
export function spread(key: string, left: Segment[], right: Segment[], columns: number): Row {
  const gap = columns - segmentsWidth(left) - segmentsWidth(right)
  if (right.length > 0 && gap >= 1) return { key, segments: [...left, { text: spaces(gap) }, ...right] }
  return { key, segments: clip(left, columns) }
}

/**
 * Segments cut to `columns`: the last text segment that crosses the edge is
 * truncated with an ellipsis, and nothing after it is kept. A pressable
 * segment is never cut: it is dropped whole, since its label is its address.
 */
export function clip(segments: Segment[], columns: number): Segment[] {
  const out: Segment[] = []
  let used = 0
  for (const s of segments) {
    const w = cells(s.text)
    if (used + w <= columns) {
      out.push(s)
      used += w
      continue
    }
    if (s.press === undefined && columns - used > 0) out.push({ ...s, text: fit(s.text, columns - used) })
    break
  }
  return out
}

export const dimRow = (key: string, text: string, columns: number): Row => ({ key, segments: [{ text: fit(text, columns), dim: true }] })
