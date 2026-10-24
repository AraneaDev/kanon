/**
 * The Kanon pane laid out as rows of segments, without drawing. Pure: a
 * status, a view and a size in, rows out, the same rows for the same input.
 * No I/O and no clock: the feedback text arrives as input and the mod clears
 * it. The mod (hooks/mod) turns the rows into elements and every pressable
 * segment into a Button.
 *
 * The list is layout A: five ruled cards, Instructions, Memory, Injected by
 * hooks, Skills, Compaction, flagged items first within their card. Two
 * promises hold at every size, and the width sweep in
 * test/pane-layout.test.ts checks both: no row is wider than `columns` and
 * there are never more rows than `rows`, the footer last.
 *
 * Height is shared the way Knossos's fitBlocks shares it, simplified: every
 * card shows at its fewest rows (a card with a flagged item never fewer than
 * one item, so a flag is never the first thing dropped), spacing goes before
 * a card does, then flagged cards grow to show all their flags, then every
 * list grows a row at a time in turn. A cut list ends `n more ↓`.
 */
import type { PaneItem, PaneModel } from '../../src/model'
import { besideRows, cardInner, cardRows, gridColumns, moreRows, type Section } from './cards'
import { MARK, mark, type Mark } from './marks'
import { HEADING } from './palette'
import { button, clip, dimRow, segmentsWidth, spread, walkedRow } from './rows'
import { cells, fit, fitStart, grouped, padEnd, pathParts } from './text'
import { tierOf, type Tier } from './tiers'
import type { Action, Row, Segment } from './types'

export type { Action, Row, Segment } from './types'
export { rowWidth } from './rows'

/** The list, or one item opened in place, by its realpath. */
export type View = { kind: 'list' } | { kind: 'detail'; real: string }
/** What the mod knows about the session: still reading it, the model, or why it could not read it. */
export type Status = { kind: 'loading' } | { kind: 'ready'; model: PaneModel } | { kind: 'error'; reason: string }
export interface LayoutInput {
  status: Status
  view: View
  columns: number
  rows: number
  /** A short note the footer carries for a moment (`✓ acknowledged`), or null. */
  feedback: string | null
}

/** The engine refuses a tree over 100,000 characters; Knossos keeps this margin under it, and so does Kanon. */
export const TEXT_BUDGET = 90_000
/** The list's share of a wide pane; the detail takes the rest, 55%. */
const LIST_SHARE = 0.45
/** The origin column: the longest origin (`project`, `foreign`, `managed`) and two cells. */
const ORIGIN_COLUMN = 9
/** The fewest cells a card needs before it spends some on the origin column. */
const ORIGIN_MIN = 40
/** The label column of the detail view (`evidence` and a cell). */
const LABEL_COLUMN = 9
/** The widest a plugin, hook or trigger column grows before its names are cut. */
const NAME_MAX = 24

const blankRow = (key: string): Row => ({ key, segments: [{ text: ' ' }] })

/**
 * The pane's rows. Never more than `rows` (fewer when the text budget caps
 * the height), never one wider than `columns`.
 */
export function layout(input: LayoutInput): Row[] {
  const width = Math.max(0, Math.floor(input.columns))
  // Every row is at most `width` cells, so this many rows can never exceed the budget.
  const height = Math.max(0, Math.min(Math.floor(input.rows), Math.floor(TEXT_BUDGET / Math.max(1, width))))
  if (width === 0 || height === 0) return []
  const { status } = input
  if (status.kind === 'loading') return loadingRows(width, height)
  if (status.kind === 'error') return errorRows(status.reason, width, height)
  return readyRows(status.model, input.view, width, height, input.feedback)
}

function loadingRows(width: number, height: number): Row[] {
  const heading: Row = { key: 'loading', segments: [{ text: fit(' Reading the session…', width), bold: true, color: HEADING }] }
  return height >= 2 ? [blankRow('loading-gap'), heading] : [heading]
}

/** A bold heading, the dim reason, one retry action; with too little height the reason goes first, the action last. */
function errorRows(reason: string, width: number, height: number): Row[] {
  const heading: Row = { key: 'error', segments: [{ text: fit(' Kanon could not read the session', width), bold: true, color: HEADING }] }
  const retry: Row = { key: 'retry', segments: clip([{ text: ' ' }, button({ kind: 'retry' }, 'retry', 'r')], width) }
  if (height === 1) return [retry]
  const lines = wrap(reason, width - 1)
    .slice(0, Math.max(0, height - 2))
    .map((line, i): Row => ({ key: `reason-${i}`, segments: [{ text: ` ${line}`, dim: true }] }))
  let rows = [heading, ...lines, retry]
  if (rows.length < height) rows = [heading, ...lines, blankRow('error-gap'), retry]
  if (rows.length < height) rows = [blankRow('error-top'), ...rows]
  return rows
}

function readyRows(model: PaneModel, view: View, width: number, height: number, feedback: string | null): Row[] {
  const items = [...model.instructions, ...model.memory]
  const opened = view.kind === 'detail' ? (items.find(i => i.real === view.real) ?? null) : null
  const firstFlagged = items.find(flagged) ?? null
  // What `o` opens and the marker marks: the opened item, else the first flagged one, else the first.
  const target = opened ?? firstFlagged ?? sortFlagged(model.instructions)[0] ?? model.memory[0] ?? null
  const keys = opened !== null ? detailKeys(opened) : target !== null ? [button({ kind: 'open', real: target.real }, 'open', 'o')] : []
  const footer = footerRow(keys, model.basis, feedback, width)
  if (height === 1) return [footer]

  const budget = height - 1
  const tier = tierOf(width)
  let body: Row[]
  if (tier === 'wide') {
    const [left, right] = gridColumns(width, LIST_SHARE)
    const shown = opened ?? firstFlagged
    const detail = shown !== null ? detailRows(shown, right, tier, budget) : hintRows(right)
    body = besideRows(listRows(model, left, tier, budget, target?.real ?? null), detail, left)
  } else if (opened !== null) {
    body = detailRows(opened, width, tier, budget)
  } else {
    body = listRows(model, width, tier, budget, target?.real ?? null)
  }
  body = body.slice(0, budget)
  // The footer is pinned to the bottom: blank rows fill what the body leaves.
  const fill = Array.from({ length: budget - body.length }, (_, i) => blankRow(`fill-${i}`))
  return [...body, ...fill, footer]
}

/**
 * The footer: the keys that work in this view, as buttons, and against the
 * right edge the basis, or the feedback while there is one. The feedback
 * replaces the basis rather than the keys, so a key stays pressable through
 * its two seconds; when both do not fit, the feedback wins.
 */
function footerRow(keys: Segment[], basis: string, feedback: string | null, width: number): Row {
  const left: Segment[] = [{ text: ' ' }, ...keys.flatMap((k, i) => (i === 0 ? [k] : [{ text: '  ' }, k]))]
  if (feedback !== null) {
    const right: Segment[] = [{ text: `${feedback} `, color: HEADING }]
    if (width - segmentsWidth(left) - segmentsWidth(right) >= 1) return spread('footer', left, right, width)
    return { key: 'footer', segments: [{ text: fit(` ${feedback}`, width), color: HEADING }] }
  }
  return spread('footer', left, [{ text: `${basis} `, dim: true }], width)
}

function detailKeys(item: PaneItem): Segment[] {
  const ack = item.verdict !== null && !item.acknowledged ? [button({ kind: 'ack', real: item.real }, 'acknowledge', 'a')] : []
  return [...ack, button({ kind: 'back' }, 'back', 'b')]
}

/** Needs the person's eye: a verdict not yet acknowledged, or a file from a dependency. */
const flagged = (item: PaneItem): boolean => (item.verdict !== null && !item.acknowledged) || item.origin === 'foreign'
const sortFlagged = (items: PaneItem[]): PaneItem[] => [...items.filter(flagged), ...items.filter(i => !flagged(i))]

/** The one glyph an item shows: an open verdict first, then foreign, then acknowledged. */
function markOf(item: PaneItem): Mark {
  if (item.verdict !== null && !item.acknowledged) return item.verdict.level === 'gone' ? MARK.gone : MARK.stale
  if (item.origin === 'foreign') return MARK.foreign
  if (item.verdict !== null) return MARK.acked
  return MARK.none
}

// ---------------------------------------------------------------- the list

/** One card of the list: how long it is, how many of it are flagged, its note, and its first `limit` rows. */
type Group = {
  key: string
  title: string
  length: number
  flagged: number
  note: Segment[]
  rows: (inner: number, limit: number, marked: string | null) => Row[]
}

/** The blank row before a card and the blank row under its title: the one under the title is given up first. */
type Density = { gap: boolean; under: boolean }
const DENSITIES: Density[] = [
  { gap: true, under: true },
  { gap: true, under: false },
  { gap: false, under: false },
]

function listRows(model: PaneModel, width: number, tier: Tier, budget: number, marked: string | null): Row[] {
  const inner = cardInner(width, tier)
  const groups = groupsOf(model, tier, inner)
  const { shown, limits, density } = allocate(groups, budget)
  return groups.flatMap((g, i) => (shown[i] ? cardLines(sectionOf(g, inner, limits[i]!, marked), width, tier, density) : []))
}

function groupsOf(model: PaneModel, tier: Tier, inner: number): Group[] {
  const showOrigin = tier !== 'narrow' && inner >= ORIGIN_MIN
  const itemGroup = (key: string, title: string, items: PaneItem[], origin: boolean): Group => {
    const sorted = sortFlagged(items)
    return {
      key,
      title,
      length: items.length,
      flagged: items.filter(flagged).length,
      note: flagNote(items),
      rows: (width, limit, marked) => sorted.slice(0, limit).map(it => itemRow(key, it, width, it.real === marked, origin)),
    }
  }
  const plainGroup = <T>(key: string, title: string, list: T[], row: (x: T, width: number) => Segment[]): Group => ({
    key,
    title,
    length: list.length,
    flagged: 0,
    note: [],
    rows: (width, limit) => list.slice(0, limit).map((x, i) => plainRow(`${key}:${i}`, row(x, width), width)),
  })

  const pw = Math.min(NAME_MAX, Math.max(0, ...model.injected.map(i => cells(i.plugin))))
  const hw = Math.min(NAME_MAX, Math.max(0, ...model.injected.map(i => cells(i.hookName))))
  const tw = Math.min(NAME_MAX, Math.max(0, ...model.compactions.map(c => cells(c.trigger))))
  return [
    itemGroup('instructions', 'Instructions', model.instructions, showOrigin),
    itemGroup('memory', 'Memory', model.memory, false),
    plainGroup('injected', 'Injected by hooks', model.injected, (inj, width) => {
      const names: Segment[] = [{ text: padEnd(fit(inj.plugin, pw), pw + 2) }, { text: padEnd(fit(inj.hookName, hw), hw + 2), dim: true }]
      const detail: Segment[] = [{ text: kilo(inj.chars), color: HEADING }, { text: ' chars', dim: true }]
      // Narrow gives up the kind detail before the names: they are the row.
      return tier === 'narrow' && segmentsWidth(names) + segmentsWidth(detail) + 2 > width ? names : [...names, ...detail]
    }),
    plainGroup('skills', 'Skills', model.skills, name => [{ text: name }]),
    plainGroup('compaction', 'Compaction', model.compactions, c => {
      const time = /T(\d\d:\d\d)/.exec(c.t)?.[1]
      return [
        ...(time === undefined ? [] : [{ text: `${time}  `, dim: true }]),
        { text: padEnd(fit(c.trigger, tw), tw + 2) },
        { text: grouped(c.preTokens), color: HEADING },
        { text: ' → ', dim: true },
        { text: grouped(c.postTokens), color: HEADING },
        { text: ' tokens', dim: true },
      ]
    }),
  ]
}

/** `9.1k`: characters in thousands, one decimal. */
const kilo = (n: number): string => `${(n / 1000).toFixed(1)}k`

/**
 * An item's row: the marker, its glyph, its origin while there is room, and
 * its path cut in the folders, the file name a button that opens it.
 */
function itemRow(group: string, item: PaneItem, inner: number, marked: boolean, showOrigin: boolean): Row {
  const lead: Segment[] = [{ text: ' ' }, mark(markOf(item), ' ')]
  const origin: Segment[] = showOrigin ? [{ text: padEnd(item.origin, ORIGIN_COLUMN), dim: true }] : []
  // The marker's column comes first, so the path has what is left after it.
  const room = inner - 1 - segmentsWidth(lead) - segmentsWidth(origin)
  return walkedRow(`${group}:${item.real}`, marked, [...lead, ...origin, ...pathSegments(item, room)], inner)
}

function pathSegments(item: PaneItem, room: number): Segment[] {
  const { dir, base } = pathParts(item.path, room)
  const action: Action = { kind: 'open', real: item.real }
  return [...(dir === '' ? [] : [{ text: dir, dim: true }]), ...(base === '' ? [] : [{ text: base, press: action }])]
}

/** A row that is not an item: no marker or glyph, its text where an item's glyph stands. */
const plainRow = (key: string, segments: Segment[], inner: number): Row => walkedRow(key, false, [{ text: ' ' }, ...segments], inner)

/** A card's note: each flag it holds with its count, `! 1 foreign · ▲ 1 gone`; empty when it holds none. */
function flagNote(items: PaneItem[]): Segment[] {
  const open = (level: 'gone' | 'may-be-stale') => items.filter(i => i.verdict?.level === level && !i.acknowledged).length
  const counts: Array<[Mark, number]> = [
    [MARK.gone, open('gone')],
    [MARK.stale, open('may-be-stale')],
    [MARK.foreign, items.filter(i => i.origin === 'foreign').length],
  ]
  return counts
    .filter(([, n]) => n > 0)
    .flatMap(([m, n], i) => [
      ...(i === 0 ? [] : [{ text: ' · ', dim: true }]),
      mark(m, ' '),
      { text: grouped(n), color: HEADING },
      { text: ` ${m.legend}`, dim: true },
    ])
}

function sectionOf(g: Group, inner: number, limit: number, marked: string | null): Section {
  if (g.length === 0) return { key: g.key, title: g.title, note: [{ text: '0', color: HEADING }], body: [], empty: '0' }
  const body = limit === 0 ? [] : [...g.rows(inner, limit, marked), ...moreRows(`${g.key}-more`, { start: 0, end: limit }, g.length, inner)]
  return { key: g.key, title: g.title, subtitle: grouped(g.length), note: g.note, body }
}

/** A card's rows at a density: the blank row before it and the one under its title only where the density keeps them. */
function cardLines(section: Section, width: number, tier: Tier, density: Density): Row[] {
  const rows = cardRows(section, width, tier).filter(r => density.under || r.key !== `${section.key}-under`)
  return density.gap ? [blankRow(`gap-${section.key}`), ...rows] : rows
}

/** The rows {@link cardLines} gives a group shown `limit` long, counted without building them. */
function cost(g: Group, limit: number, d: Density): number {
  const head = (d.gap ? 1 : 0) + 1
  if (g.length === 0 || limit === 0) return head
  return head + (d.under ? 1 : 0) + limit + (limit < g.length ? 1 : 0)
}

/**
 * Which cards show, how long each list is, and at what density, in
 * `budget` rows. A card with a flag shows at least one item (its first, a
 * flagged one); the others may show their title alone, which carries the
 * count. Spacing goes before a card does; when even the tightest does not
 * fit, cards without a flag go first, from the last.
 */
function allocate(groups: Group[], budget: number): { shown: boolean[]; limits: number[]; density: Density } {
  const limits = groups.map(g => (g.flagged > 0 ? 1 : 0))
  const shown = groups.map(() => true)
  const total = (d: Density) => groups.reduce((n, g, i) => n + (shown[i] ? cost(g, limits[i]!, d) : 0), 0)
  let density = DENSITIES.find(d => total(d) <= budget)
  if (density === undefined) {
    density = DENSITIES[DENSITIES.length - 1]!
    const order = [...groups.keys()].reverse()
    for (const i of [...order.filter(i => groups[i]!.flagged === 0), ...order.filter(i => groups[i]!.flagged > 0)]) {
      if (total(density) <= budget) break
      shown[i] = false
    }
  }
  const d = density
  const grow = (most: (i: number) => number): void => {
    const open = new Set(groups.keys())
    while (open.size > 0) {
      for (const i of [...open]) {
        if (!shown[i] || limits[i]! >= most(i)) {
          open.delete(i)
          continue
        }
        limits[i]! += 1
        if (total(d) > budget) {
          limits[i]! -= 1
          open.delete(i)
        }
      }
    }
  }
  // Flags first, every one of them; then every list a row at a time in turn.
  grow(i => (groups[i]!.flagged > 0 ? groups[i]!.flagged : limits[i]!))
  grow(i => groups[i]!.length)
  return { shown, limits, density: d }
}

// -------------------------------------------------------------- the detail

/** An item opened in place: what it is, where it came from, and for a flag its evidence and whether it was acknowledged. */
function detailRows(item: PaneItem, width: number, tier: Tier, budget: number): Row[] {
  const inner = cardInner(width, tier)
  const value = inner - 2 - LABEL_COLUMN
  const field = (key: string, label: string, segments: Segment[]): Row => ({
    key: `detail-${key}`,
    segments: clip([{ text: '  ' }, { text: padEnd(label, LABEL_COLUMN), dim: true }, ...segments], inner),
  })
  const rows: Row[] = [
    field('path', 'path', pathSegments(item, value)),
    field('origin', 'origin', [{ text: item.origin }]),
    field('reason', 'reason', item.reason === null ? [{ text: 'not observed', dim: true }] : [{ text: item.reason }]),
  ]
  if (item.verdict === null) {
    rows.push(field('verdict', 'verdict', [{ text: 'none', dim: true }]))
  } else {
    const verdict = item.verdict.level === 'gone' ? MARK.gone : MARK.stale
    rows.push(field('verdict', 'verdict', [mark(verdict, ' '), { text: item.verdict.level === 'gone' ? 'gone' : 'may be stale' }]))
    wrap(item.verdict.evidence, value).forEach((line, i) => rows.push(field(`evidence-${i}`, i === 0 ? 'evidence' : '', [{ text: line }])))
    rows.push(field('state', 'state', item.acknowledged ? [mark(MARK.acked, ' '), { text: 'acknowledged, still holds' }] : [{ text: 'not acknowledged', dim: true }]))
  }
  const state = markOf(item)
  const note = state === MARK.none ? [] : [mark(state, ' '), { text: state.legend, dim: true }]
  const title = item.path.slice(item.path.lastIndexOf('/') + 1)
  return cardLines({ key: 'detail', title, subtitle: item.kind, note, body: rows }, width, tier, DENSITIES[0]!).slice(0, budget)
}

function hintRows(width: number): Row[] {
  return [blankRow('hint-gap'), dimRow('hint', '  Nothing flagged. o opens the marked file.', width)]
}

/** `text` in lines of at most `width` cells, broken between words; a word too long alone is cut, a path from its front. */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return []
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(w => w !== '')) {
      const next = line === '' ? word : `${line} ${word}`
      if (cells(next) <= width) {
        line = next
        continue
      }
      if (line !== '') out.push(line)
      line = cells(word) <= width ? word : word.includes('/') ? fitStart(word, width) : fit(word, width)
    }
    if (line !== '') out.push(line)
  }
  return out
}
