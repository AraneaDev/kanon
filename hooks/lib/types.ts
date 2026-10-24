// Copied from Knossos-MCP hooks/lib/types.ts at a4412478, trimmed to what Kanon's pane uses.
import type { Tone } from './palette'

/**
 * The shapes the pane draws with: styled segments and the rows they make up.
 * Types only; `rows.ts` and `text.ts` hold the primitives that build them.
 * Knossos's raster, diff, field, hover and wheel members are not here: the pane
 * draws text rows only.
 */
/** A pressable segment: drawn as a plain Button, `hotkey: label` when it has a hotkey. */
export type Press = { id: string; label: string; hotkey?: string }

/**
 * A run of text in one style. `color` is a Claude Code theme key (see
 * `palette.ts`), never a hex value; `dim` marks secondary text, drawn in the
 * theme's `inactive`; `bg` a theme key laid under it.
 */
export type Segment = { text: string; color?: Tone; dim?: boolean; bold?: boolean; bg?: string; press?: Press }

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
