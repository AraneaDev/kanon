// Copied from Knossos-MCP hooks/lib/types.ts at a4412478, trimmed to what Kanon's pane uses.
import type { Tone } from './palette'

/**
 * The shapes the pane draws with: styled segments and the rows they make up.
 * Types only; `rows.ts` and `text.ts` hold the primitives that build them.
 * Knossos's raster, diff, field, hover and wheel members are not here: the pane
 * draws text rows only.
 */
/**
 * What pressing a segment does: open an item in place (by its realpath) or a
 * collapsed injection (by its key), go back one level, acknowledge an item
 * (the record `kanon ack` writes), retry a failed read, view the text of what
 * is open, or page that text. The mod turns a segment carrying one into a
 * Button.
 */
export type Action =
  | { kind: 'open'; real: string }
  | { kind: 'open'; injection: string }
  | { kind: 'back' }
  | { kind: 'ack'; real: string }
  | { kind: 'retry' }
  | { kind: 'view' }
  | { kind: 'next' }
  | { kind: 'previous' }

/**
 * A run of text in one style. `color` is a Claude Code theme key (see
 * `palette.ts`), never a hex value; `dim` marks secondary text, drawn in the
 * theme's `inactive`; `bg` a theme key laid under it. A segment with `press`
 * is a button, drawn exactly as its text (`hotkey: label` when it has a
 * `hotkey`, one digit or lowercase letter), since a terminal Button does not
 * show its hotkey itself.
 */
export type Segment = { text: string; color?: Tone; dim?: boolean; bold?: boolean; bg?: string; press?: Action; hotkey?: string }

/** One line of the pane. */
export type Row = {
  key: string
  segments: Segment[]
  /** In a row of the wide grid, the index of the first segment of the right card's row: everything before it is the left card's and the gap. */
  split?: number
  /** The background the whole row is tinted with (the marked row): a card's frame carries it to its inner edge. */
  tint?: string
  /** The cells a card's gutter lays before the row's own content (two in a medium or wide card). */
  inset?: number
}
