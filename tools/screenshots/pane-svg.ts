/**
 * Draws the Kanon pane as an SVG card for the README, from a real
 * `kanon model --json`.
 *
 * The pane is a terminal UI that only Claude Code can run, so pyte cannot
 * capture it the way screenshots.py captures the CLI. What can be captured is
 * the pane's own pure layout: `layout()` from hooks/lib/layout.ts, the code the
 * mod draws, given the model the real CLI printed. Every row in the image is a
 * row `layout()` returned, unedited; this file only paints them.
 *
 * With `--chat`, a Claude Code session sits to the left of the pane: the
 * SessionStart brief's first line (from a real `kanon brief` run, passed as a
 * file), then a short scripted exchange showing what the pane is for. The
 * exchange is synthetic and says so here: no session produced it. The prompt
 * box and the mode line sit under both, as in the terminal.
 *
 * The colours are Claude Code's theme keys (hooks/lib/palette.ts) mapped to
 * fixed values on a dark ground, the same mapping Minos's session card uses,
 * because an SVG cannot follow a terminal's theme. One `<text>` per line, its
 * runs as `<tspan>`s, so the columns stay true.
 *
 * Usage: bun tools/screenshots/pane-svg.ts <model.json> <out.svg>
 *          [--columns 96] [--rows 34] [--chat brief.txt] [--detail <real>]
 */
import { layout, type Row, type Segment, type View } from '../../hooks/lib/layout'
import { cells } from '../../hooks/lib/text'
import type { PaneModel } from '../../src/model'

const GROUND = '#10151d'
const BODY = '#b8c0cb'
const DIM = '#63707f'
const BONE = '#ece5d5'
const FRAME = '#3a4553'
const THEME: Record<string, string> = {
  text: BONE,
  success: '#7fb3a3',
  warning: '#d8a13f',
  suggestion: '#9a8fd0',
  error: '#cf6a63',
  inactive: DIM,
  subtle: FRAME,
  claude: '#d97757',
  userMessageBackground: '#1f2733',
}

const FONT_SIZE = 13
const LINE_HEIGHT = 19
const CHAR_WIDTH = FONT_SIZE * 0.6
const PAD = 22
const FONT = 'ui-monospace, SFMono-Regular, &#34;SF Mono&#34;, Menlo, Consolas, &#34;DejaVu Sans Mono&#34;, monospace'

/** The chat column's width, and the rule between it and the pane. */
const CHAT = 62
const GAP = 3

/** A drawn line: runs of text in the pane's own segment shape. */
type Line = { runs: Segment[] }

const argv = process.argv.slice(2)
const [modelPath, out] = argv
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
if (modelPath === undefined || out === undefined) {
  throw new Error('usage: pane-svg.ts <model.json> <out.svg> [--columns n] [--rows n] [--chat brief.txt] [--detail real]')
}
const columns = Number(option('columns') ?? 96)
const rows = Number(option('rows') ?? 34)
const chatFile = option('chat')
const detail = option('detail')

const model = JSON.parse(await Bun.file(modelPath).text()) as PaneModel & { error?: string }
if (model.error !== undefined) throw new Error(`kanon model failed: ${model.error}`)
const view: View = detail === undefined ? { kind: 'list' } : { kind: 'detail', real: detail }
const pane: Row[] = layout({ status: { kind: 'ready', model }, view, columns, rows, feedback: null, frame: 0 })
if (detail !== undefined && !pane.some((r) => r.key === 'detail-path')) throw new Error(`no item with real ${detail} in the model`)

/** Words wrapped to `width`, the first line led by `lead` and the rest indented to match. */
function wrap(text: string, width: number, lead: Segment, rest: Omit<Segment, 'text'> = {}): Line[] {
  const room = width - cells(lead.text)
  const lines: Line[] = []
  let line = ''
  const push = () => lines.push({ runs: [lines.length === 0 ? lead : { text: ' '.repeat(cells(lead.text)) }, { ...rest, text: line }] })
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line === '') line = word
    else if (cells(line) + 1 + cells(word) <= room) line = `${line} ${word}`
    else {
      push()
      line = word
    }
  }
  if (line !== '') push()
  return lines
}

/**
 * The scripted exchange: the moment the pane exists for. Claude is about to
 * act on a memory, the pane has flagged that memory gone, and Claude asks
 * before following it instead of running a script that is not there.
 */
async function chatLines(): Promise<Line[]> {
  if (chatFile === undefined) return []
  const brief = (await Bun.file(chatFile).text()).split('\n')[0] ?? ''
  const prompt = (text: string): Line[] => [...wrap(text, CHAT, { text: '> ', dim: true }, { dim: true }), { runs: [] }]
  const reply = (text: string): Line[] => [...wrap(text, CHAT, { text: '⏺ ' }), { runs: [] }]
  return [
    ...wrap(`SessionStart:startup says: ${brief}`, CHAT, { text: '⎿  ', dim: true }, { dim: true }),
    { runs: [] },
    ...prompt('cut a release'),
    ...reply('Before I follow memory/release-flow.md: it names scripts/release.sh, which no longer exists. Does it still hold?'),
    ...prompt('no, we use release-please now'),
    ...reply("Then I'll update that memory to say releases go through release-please, and drop the script."),
  ]
}
const chat = await chatLines()
const withChat = chat.length > 0

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One run's colour and weight as SVG attributes, as hooks/mod/draw.tsx styles a Text: its theme key, else `inactive` when dim. */
function paint(s: Segment): string {
  const fill = s.color !== undefined ? (THEME[s.color] ?? BODY) : s.dim === true ? DIM : s.bold === true ? BONE : BODY
  return [`fill="${fill}"`, s.bold === true ? 'font-weight="bold"' : ''].filter(Boolean).join(' ')
}

const chatCols = withChat ? CHAT + GAP : 0
const footerRows = withChat ? 4 : 0
const width = Math.ceil((chatCols + columns) * CHAR_WIDTH + PAD * 2)
const height = (rows + footerRows) * LINE_HEIGHT + PAD * 2
const y = (row: number): number => PAD + LINE_HEIGHT * (row + 1) - 5
const x = (col: number): number => PAD + col * CHAR_WIDTH

const drawn: string[] = []
const text = (line: Line, row: number, col: number) => {
  // A segment's background (the marked row's tint) is laid under exactly the cells it covers.
  let at = col
  for (const s of line.runs) {
    const w = cells(s.text)
    if (s.bg !== undefined) drawn.push(`  <rect x="${x(at)}" y="${y(row) - LINE_HEIGHT + 6}" width="${w * CHAR_WIDTH}" height="${LINE_HEIGHT}" fill="${THEME[s.bg] ?? FRAME}"/>`)
    at += w
  }
  const spans = line.runs.filter((s) => s.text !== '').map((s) => `<tspan ${paint(s)}>${escapeXml(s.text)}</tspan>`).join('')
  if (spans !== '') drawn.push(`  <text x="${x(col)}" y="${y(row)}" xml:space="preserve">${spans}</text>`)
}

chat.slice(0, rows).forEach((line, i) => text(line, i, 0))
pane.forEach((row, i) => text({ runs: row.segments }, i, chatCols))

if (withChat) {
  // The rule between the chat and the pane, as the terminal draws a docked pane.
  const ruleX = x(CHAT + 1) + CHAR_WIDTH / 2
  drawn.push(`  <line x1="${ruleX}" y1="${PAD}" x2="${ruleX}" y2="${y(rows - 1) + 6}" stroke="${FRAME}" stroke-width="1"/>`)
  // The prompt box and the mode line under both columns.
  const boxTop = y(rows) - LINE_HEIGHT + 10
  drawn.push(`  <rect x="${PAD}" y="${boxTop}" width="${(chatCols + columns) * CHAR_WIDTH}" height="${LINE_HEIGHT * 2}" rx="6" fill="none" stroke="${FRAME}"/>`)
  text({ runs: [{ text: '> ', dim: true }] }, rows + 1, 1)
  text({ runs: [{ text: '? for shortcuts', dim: true }] }, rows + 3, 1)
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="${FONT_SIZE}">
  <rect width="${width}" height="${height}" rx="8" fill="${GROUND}"/>
${drawn.join('\n')}
</svg>
`

await Bun.write(out, svg)
console.log(`wrote ${out}  ${width}x${height}  pane ${columns}x${rows}, ${pane.length} rows${withChat ? `, chat ${chat.length} lines` : ''}`)
