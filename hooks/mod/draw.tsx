/**
 * The laid-out rows (hooks/lib/layout.ts) as elements: each row a Box
 * exactly the pane's width that clips at its edge, each run of plain
 * segments one Text, and each pressable segment a Button. Drawing acts on
 * nothing: what a press does is handed in.
 *
 * A Button with a hotkey draws `x: label` itself, so its label is the
 * segment's text with that `x: ` taken off: the layout lays out `b: back`
 * and the engine draws exactly that. Passing the whole text drew `b: b:`
 * once the box cut it (seen live in 0.0.22). A Button cannot take a
 * background, so it stands in a Box of the segment's width that carries it.
 *
 * JSX compiles to the engine's `h` and `Fragment` globals; neither is
 * imported, and no variable here is named `h`.
 */
import type { Elements, RenderElement, RenderNode, RenderSurface } from 'claude-code'

import { SECONDARY } from '../lib/palette'
import { cells } from '../lib/text'
import type { Action, Row, Segment } from '../lib/types'

type Ui = Elements[RenderSurface]

/** How a segment's Text is styled: its theme key, else `inactive` when dim; bold; the background laid under it. */
function textStyle(s: Segment): { color?: string; bold?: boolean; backgroundColor?: string } {
  const color = s.color ?? (s.dim ? SECONDARY : undefined)
  return { ...(color === undefined ? {} : { color }), ...(s.bold ? { bold: true } : {}), ...(s.bg === undefined ? {} : { backgroundColor: s.bg }) }
}

const sameStyle = (a: Segment, b: Segment): boolean => JSON.stringify(textStyle(a)) === JSON.stringify(textStyle(b))

/** A Button's key: by its hotkey where it has one (one per view), else by its place in the row. */
const buttonKey = (row: Row, s: Segment, i: number): string => (s.hotkey === undefined ? `${row.key}#${i}` : `key-${s.hotkey}`)

/** The label a Button is given: its text without the `x: ` the engine draws for its hotkey. */
export function buttonLabel(s: Segment): string {
  if (s.hotkey === undefined) return s.text
  const prefix = `${s.hotkey}: `
  return s.text.startsWith(prefix) ? s.text.slice(prefix.length) : s.text
}

/** The pane's rows as one column, `columns` wide. */
export function drawRows(ui: Ui, rows: Row[], columns: number, press: (action: Action) => void): RenderElement {
  const { Box } = ui
  return (
    <Box key="kanon" flexDirection="column" width={columns} overflow="hidden">
      {rows.map(row => drawRow(ui, row, columns, press))}
    </Box>
  )
}

function drawRow(ui: Ui, row: Row, columns: number, press: (action: Action) => void): RenderNode {
  const { Box, Button } = ui
  const drawn: RenderNode[] = []
  for (let i = 0; i < row.segments.length; i++) {
    const s = row.segments[i]!
    const action = s.press
    if (action !== undefined) {
      const key = buttonKey(row, s, i)
      drawn.push(
        <Box key={`${key}-box`} width={cells(s.text)} flexShrink={0} {...(s.bg === undefined ? {} : { backgroundColor: s.bg })}>
          <Button
            key={key}
            plain
            label={buttonLabel(s)}
            {...(s.hotkey === undefined ? {} : { hotkey: s.hotkey })}
            {...(s.dim ? { dimColor: true } : {})}
            onPress={() => press(action)}
          />
        </Box>,
      )
      continue
    }
    const run: Segment[] = [s]
    while (i + 1 < row.segments.length && row.segments[i + 1]!.press === undefined) run.push(row.segments[++i]!)
    drawn.push(textRun(ui, run))
  }
  return (
    <Box key={row.key} flexDirection="row" width={columns} overflow="hidden">
      {drawn}
    </Box>
  )
}

/** A run of plain segments as one Text that cuts at its edge: a lone style on the Text itself, else each styled piece nested. */
function textRun(ui: Ui, run: Segment[]): RenderNode {
  const { Text } = ui
  const pieces: Segment[] = []
  for (const s of run) {
    const last = pieces[pieces.length - 1]
    if (last !== undefined && sameStyle(last, s)) pieces[pieces.length - 1] = { ...last, text: last.text + s.text }
    else pieces.push(s)
  }
  if (pieces.length === 1) {
    return (
      <Text wrap="truncate-end" {...textStyle(pieces[0]!)}>
        {pieces[0]!.text}
      </Text>
    )
  }
  return (
    <Text wrap="truncate-end">
      {pieces.map(p => (Object.keys(textStyle(p)).length === 0 ? p.text : <Text {...textStyle(p)}>{p.text}</Text>))}
    </Text>
  )
}
