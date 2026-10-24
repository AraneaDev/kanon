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
 * Height is shared the way Knossos's fitBlocks shares it, simplified: what
 * gives way first is spacing, then cards without a flag, then flags beyond
 * each card's first, then flagged cards, so a flag is never the first thing
 * dropped; what is left grows every list a row at a time in turn. A cut list
 * ends `n more ↓`. Only the wide tier has a marker: it marks the item the
 * right half previews. Narrower, each file name is its own open button.
 */
import type { InjectedGroup, PaneItem, PaneModel } from '../../src/model'
import { stripControl } from './control'
import { besideRows, cardInner, cardRows, gridColumns, moreRows, type Section } from './cards'
import { MARK, mark, type Mark } from './marks'
import { ACCENT, HEADING } from './palette'
import { button, clip, dimRow, segmentsWidth, spread, walkedRow } from './rows'
import { cells, fit, fitStart, grouped, padEnd, pathParts, spaces, wrapCells } from './text'
import { tierOf, type Tier } from './tiers'
import type { Action, Row, Segment } from './types'

export type { Action, Row, Segment } from './types'
export { rowWidth } from './rows'

/** What a detail or the content view is about: an item by its realpath, or a collapsed injection by its key ({@link injectionKey}). */
export type Target = { real: string } | { injection: string }
/**
 * The list; one item or injection opened in place; or the text of one, read
 * from `scroll`, the first row shown. `b` steps back one level: content to
 * detail to list.
 */
export type View = { kind: 'list' } | ({ kind: 'detail' } & Target) | ({ kind: 'content'; scroll: number } & Target)
/**
 * The text the content view shows, as `kanon show` printed it, independent of
 * the model's status: the lines, still reading, or why it could not be read.
 */
export type Content = { title: string; lines: string[]; truncated: boolean } | { loading: true } | { error: string }
/** What the mod knows about the session: still reading it, the model, or why it could not read it. */
export type Status = { kind: 'loading' } | { kind: 'ready'; model: PaneModel } | { kind: 'error'; reason: string }
export interface LayoutInput {
  status: Status
  view: View
  columns: number
  rows: number
  /** A short note the footer carries for a moment (`✓ acknowledged`), or null. */
  feedback: string | null
  /** The loading spinner's frame; the mod advances it on a clock while loading, so the layout needs none. */
  frame: number
  /** The content view's text; null (or absent) outside it. */
  content?: Content | null
  /**
   * Whether the pane holds the keyboard (the engine's `isFocused`). A hotkey
   * works only then: live, after Escape or a click in the prompt, `b` went
   * into the prompt. False puts the way back in the footer; absent is taken
   * as focused.
   */
  focused?: boolean
}

/** What the footer says, in place of the basis, while the pane does not hold the keyboard. */
export const FOCUS_HINT = 'click the pane for its keys'

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
/** The loading spinner, one glyph a frame. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const blankRow = (key: string): Row => ({ key, segments: [{ text: ' ' }] })

/**
 * The key a collapsed injection is opened by: its plugin and hook, the pair
 * it is grouped by. Not its index, which moves to the newest injection every
 * time the hook fires again, so an injection opened across a turn's end
 * would close under the person.
 */
export const injectionKey = (g: Pick<InjectedGroup, 'plugin' | 'hookName'>): string => JSON.stringify([g.plugin, g.hookName])

/** An injection as the layout draws it: names stripped, and the key it is opened by, taken from the names as the model gave them. */
type ShownInjection = InjectedGroup & { key: string }
type ShownModel = Omit<PaneModel, 'injected'> & { injected: ShownInjection[] }

/** The rows of the pane's height a layout `columns` wide can use: `rows`, or fewer when the text budget caps it. */
function heightOf(columns: number, rows: number): number {
  return Math.max(0, Math.min(Math.floor(rows), Math.floor(TEXT_BUDGET / Math.max(1, columns))))
}

/**
 * The pane's rows. Never more than `rows` (fewer when the text budget caps
 * the height), never one wider than `columns`.
 */
export function layout(input: LayoutInput): Row[] {
  const width = Math.max(0, Math.floor(input.columns))
  // Every row is at most `width` cells, so this many rows can never exceed the budget.
  const height = heightOf(width, input.rows)
  if (width === 0 || height === 0) return []
  const { status } = input
  if (status.kind === 'loading') return loadingRows(width, height, input.frame)
  if (status.kind === 'error') return errorRows(stripControl(status.reason), width, height)
  const model = shown(status.model)
  // The footer's right edge: the basis, or how to give the pane the keyboard.
  const note = input.focused === false ? FOCUS_HINT : model.basis
  if (input.view.kind === 'content') return contentRows(model, input.view, input.content ?? { loading: true }, width, height, input.feedback, note)
  return readyRows(model, input.view, width, height, input.feedback, note)
}

/**
 * The model with every string the pane draws stripped of control characters
 * (see `control.ts`): paths, origins, kinds, reasons, evidence, plugin, hook and skill names,
 * compaction triggers and times, the basis. Stripped here, once, so no
 * display point can miss it. `real` is left exactly as given: it is the
 * action's key, never drawn, and `kanon ack` must receive it unchanged.
 */
function shown(model: PaneModel): ShownModel {
  const item = (i: PaneItem): PaneItem => ({
    ...i,
    path: stripControl(i.path),
    origin: stripControl(i.origin) as PaneItem['origin'],
    kind: stripControl(i.kind) as PaneItem['kind'],
    reason: i.reason === null ? null : stripControl(i.reason),
    verdict: i.verdict === null ? null : { ...i.verdict, evidence: stripControl(i.verdict.evidence) },
  })
  return {
    ...model,
    basis: stripControl(model.basis) as PaneModel['basis'],
    instructions: model.instructions.map(item),
    memory: model.memory.map(item),
    injected: model.injected.map(i => ({ ...i, key: injectionKey(i), plugin: stripControl(i.plugin), hookName: stripControl(i.hookName) })),
    skills: model.skills.map(stripControl),
    compactions: model.compactions.map(c => ({ ...c, t: stripControl(c.t), trigger: stripControl(c.trigger) })),
  }
}

function loadingRows(width: number, height: number, frame: number): Row[] {
  const n = Number.isFinite(frame) ? Math.abs(Math.floor(frame)) : 0
  const glyph = SPINNER[n % SPINNER.length]!
  const segments = clip([{ text: ` ${glyph} `, color: ACCENT }, { text: 'Reading the session…', bold: true, color: HEADING }], width)
  const heading: Row = { key: 'loading', segments }
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

function readyRows(model: ShownModel, view: Exclude<View, { kind: 'content' }>, width: number, height: number, feedback: string | null, note: string): Row[] {
  const items = [...model.instructions, ...model.memory]
  const opened = view.kind === 'detail' && 'real' in view ? (items.find(i => i.real === view.real) ?? null) : null
  const openedInjection = view.kind === 'detail' && 'injection' in view ? (model.injected.find(g => g.key === view.injection) ?? null) : null
  const tier = tierOf(width)
  // The wide tier previews an item beside the list: the opened one, else the first flagged one.
  // Only there is there a marker, an `o` that opens the previewed item, and an `a` for it;
  // narrower, each file name is its own open button.
  const previewed = tier === 'wide' && openedInjection === null ? (opened ?? items.find(flagged) ?? null) : null
  const keys: Segment[][] =
    opened !== null
      ? detailKeys(opened).map(k => [k])
      : openedInjection !== null
        ? INJECTION_KEYS
        : [
            ...(items.length + model.injected.length > 0 ? LIST_KEYS : []),
            ...(previewed !== null ? [[button({ kind: 'open', real: previewed.real }, 'open', 'o')], ...ackKey(previewed).map(k => [k])] : []),
          ]
  const footer = footerRow(keys, note, feedback, width)
  if (height === 1) return [footer]

  const budget = height - 1
  let body: Row[]
  if (tier === 'wide') {
    const [left, right] = gridColumns(width, LIST_SHARE)
    const detail =
      openedInjection !== null
        ? injectionDetailRows(openedInjection, right, tier, budget)
        : previewed !== null
          ? detailRows(previewed, right, tier, budget)
          : hintRows(right, items.length === 0)
    body = besideRows(listRows(model, left, tier, budget, previewed?.real ?? openedInjection?.key ?? null), detail, left)
  } else if (opened !== null) {
    body = detailRows(opened, width, tier, budget)
  } else if (openedInjection !== null) {
    body = injectionDetailRows(openedInjection, width, tier, budget)
  } else {
    body = listRows(model, width, tier, budget, null)
  }
  return pinned(body, budget, footer)
}

/** `body` cut to `budget` rows, blank rows filling what it leaves, and the footer pinned under them. */
function pinned(body: Row[], budget: number, footer: Row): Row[] {
  const cut = body.slice(0, budget)
  const fill = Array.from({ length: budget - cut.length }, (_, i) => blankRow(`fill-${i}`))
  return [...cut, ...fill, footer]
}

/**
 * The footer: the keys that work in this view, and against the right edge
 * the basis, or the feedback while there is one. The feedback replaces the
 * basis rather than the keys, so a key stays pressable through its two
 * seconds; when both do not fit, the feedback wins. A footer too narrow for
 * every key gives up the first ones: the last is `b`, wherever there is one,
 * and a view nobody can leave is worse than one with fewer shortcuts.
 */
function footerRow(keys: Segment[][], note: string, feedback: string | null, width: number): Row {
  let kept = keys
  while (kept.length > 1 && 1 + keysWidth(kept) > width) kept = kept.slice(1)
  const left: Segment[] = [{ text: ' ' }, ...kept.flatMap((k, i) => (i === 0 ? k : [{ text: '  ' }, ...k]))]
  if (feedback !== null) {
    const right: Segment[] = [{ text: `${feedback} `, color: HEADING }]
    if (width - segmentsWidth(left) - segmentsWidth(right) >= 1) return spread('footer', left, right, width)
    return { key: 'footer', segments: [{ text: fit(` ${feedback}`, width), color: HEADING }] }
  }
  return spread('footer', left, [{ text: `${note} `, dim: true }], width)
}

const keysWidth = (keys: Segment[][]): number => keys.reduce((n, k, i) => n + segmentsWidth(k) + (i === 0 ? 0 : 2), 0)

/**
 * A key the engine handles rather than a Button of the pane's, drawn the way
 * a plain Button draws its hotkey (the key in the accent, then its label) so
 * the footer reads as one set of keys. Text, not a Button: pressing the words
 * would do nothing.
 */
const engineKey = (key: string, label: string): Segment[] => [{ text: key, color: ACCENT }, { text: `: ${label}` }]

/**
 * The list's own keys. Tab walks the focus over the file names and Enter
 * presses the one it is on; nothing in the pane said so, and a footer that
 * read only `observed` left the person guessing what could be pressed.
 */
const LIST_KEYS: Segment[][] = [engineKey('tab', 'move'), engineKey('enter', 'open')]

const viewKey = (): Segment => button({ kind: 'view' }, 'view', 'v')
const backKey = (): Segment => button({ kind: 'back' }, 'back', 'b')
const INJECTION_KEYS: Segment[][] = [[viewKey()], [backKey()]]

/** `a: acknowledge`, for an item with a verdict not yet acknowledged; else nothing. */
const ackKey = (item: PaneItem): Segment[] => (item.verdict !== null && !item.acknowledged ? [button({ kind: 'ack', real: item.real }, 'acknowledge', 'a')] : [])

const detailKeys = (item: PaneItem): Segment[] => [...ackKey(item), viewKey(), backKey()]

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

function listRows(model: ShownModel, width: number, tier: Tier, budget: number, marked: string | null): Row[] {
  const inner = cardInner(width, tier)
  const groups = groupsOf(model, tier, inner)
  const { shown, limits, density } = allocate(groups, budget)
  return groups.flatMap((g, i) => (shown[i] ? cardLines(sectionOf(g, inner, limits[i]!, marked), width, tier, density) : []))
}

function groupsOf(model: ShownModel, tier: Tier, inner: number): Group[] {
  const showOrigin = tier !== 'narrow' && inner >= ORIGIN_MIN
  const itemGroup = (key: string, title: string, items: PaneItem[], origin: boolean): Group => {
    const sorted = sortFlagged(items)
    return {
      key,
      title,
      length: items.length,
      flagged: items.filter(flagged).length,
      note: flagNote(items, tier === 'narrow'),
      rows: (width, limit, marked) => sorted.slice(0, limit).map(it => itemRow(key, it, width, it.real === marked, origin)),
    }
  }
  const plainGroup = <T>(key: string, title: string, list: T[], row: (x: T, width: number) => Segment[], id?: (x: T) => string): Group => ({
    key,
    title,
    length: list.length,
    flagged: 0,
    note: [],
    rows: (width, limit, marked) =>
      list.slice(0, limit).map((x, i) => (id === undefined ? plainRow(`${key}:${i}`, row(x, width), width) : walkedRow(`${key}:${id(x)}`, id(x) === marked, [{ text: ' ' }, ...row(x, width)], width))),
  })

  const pw = Math.min(NAME_MAX, Math.max(0, ...model.injected.map(i => cells(i.plugin))))
  const cw = Math.max(0, ...model.injected.map(i => cells(times(i.count))))
  const hw = Math.min(NAME_MAX, Math.max(0, ...model.injected.map(i => cells(i.hookName))))
  const tw = Math.min(NAME_MAX, Math.max(0, ...model.compactions.map(c => cells(c.trigger))))
  return [
    itemGroup('instructions', 'Instructions', model.instructions, showOrigin),
    itemGroup('memory', 'Memory', model.memory, false),
    plainGroup('injected', 'Injected by hooks', model.injected, (inj, width) => {
      // The plugin name is the button that opens the injection, as a file name opens a file.
      const plugin = fit(inj.plugin, pw)
      const open: Segment[] = plugin === '' ? [] : [button({ kind: 'open', injection: inj.key }, plugin)]
      const names: Segment[] = [...open, { text: spaces(pw + 2 - cells(plugin)) }, { text: padEnd(fit(inj.hookName, hw), hw + 2), dim: true }]
      const detail: Segment[] = [{ text: padEnd(times(inj.count), cw + 2), dim: true }, { text: kilo(inj.chars), color: HEADING }, { text: ' chars', dim: true }]
      // Narrow gives up the kind detail before the names: they are the row.
      return tier === 'narrow' && segmentsWidth(names) + segmentsWidth(detail) + 2 > width ? names : [...names, ...detail]
    }, inj => inj.key),
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

/** How many injections a collapsed row stands for: `×88`. */
const times = (n: number): string => `×${grouped(n)}`

/** `42` below a thousand, `9.1k` from there: in thousands, under 50 would read `0.0k`. */
const kilo = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)

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

/**
 * A card's note: each flag it holds with its count, `! 1 foreign · ▲ 1 gone`;
 * `terse`, glyph and count only (`▲ 1 · ! 1`), so a narrow header keeps its
 * flags. Empty when it holds none.
 */
function flagNote(items: PaneItem[], terse: boolean): Segment[] {
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
      ...(terse ? [] : [{ text: ` ${m.legend}`, dim: true }]),
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
 * `budget` rows. The order of what gives way is the order of what matters
 * least: spacing first, then cards without a flag (from the last), then
 * flagged items beyond each card's first, then flagged cards (from the
 * last). So a card with a flag shows every flag before a plain card keeps
 * even its title, and never shows its title without a flagged item under
 * it. Whatever is left grows every list a row at a time in turn.
 */
function allocate(groups: Group[], budget: number): { shown: boolean[]; limits: number[]; density: Density } {
  const limits = groups.map(g => g.flagged)
  const shown = groups.map(() => true)
  const total = (d: Density) => groups.reduce((n, g, i) => n + (shown[i] ? cost(g, limits[i]!, d) : 0), 0)
  let density = DENSITIES.find(d => total(d) <= budget)
  if (density === undefined) {
    const d = DENSITIES[DENSITIES.length - 1]!
    density = d
    const fits = () => total(d) <= budget
    const last = [...groups.keys()].reverse()
    for (const i of last.filter(i => groups[i]!.flagged === 0)) {
      if (fits()) break
      shown[i] = false
    }
    // Flags beyond the first of each card, one at a time from the last card, until they fit.
    while (!fits()) {
      const i = last.find(i => shown[i] && limits[i]! > 1)
      if (i === undefined) break
      limits[i]! -= 1
    }
    for (const i of last) {
      if (fits()) break
      shown[i] = false
    }
  }
  const d = density
  const open = new Set([...groups.keys()].filter(i => shown[i]))
  while (open.size > 0) {
    for (const i of [...open]) {
      if (limits[i]! >= groups[i]!.length) {
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
  return { shown, limits, density: d }
}

// -------------------------------------------------------------- the detail

/** A detail's labelled row: the label in its column, dim, then the value, cut to the card's inner width. */
function fieldOf(inner: number): (key: string, label: string, segments: Segment[]) => Row {
  return (key, label, segments) => ({
    key: `detail-${key}`,
    segments: clip([{ text: '  ' }, { text: padEnd(label, LABEL_COLUMN), dim: true }, ...segments], inner),
  })
}

/** A detail card in `budget` rows: the spacing goes before any of the content does. */
function detailCard(section: Section, width: number, tier: Tier, budget: number): Row[] {
  const lines = DENSITIES.map(d => cardLines(section, width, tier, d))
  return (lines.find(l => l.length <= budget) ?? lines[lines.length - 1]!).slice(0, budget)
}

/** The name a card shows for an item: its file name. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** An item opened in place: what it is, where it came from, and for a flag its evidence and whether it was acknowledged. */
function detailRows(item: PaneItem, width: number, tier: Tier, budget: number): Row[] {
  const inner = cardInner(width, tier)
  const value = inner - 2 - LABEL_COLUMN
  const field = fieldOf(inner)
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
  return detailCard({ key: 'detail', title: baseName(item.path), subtitle: item.kind, note, body: rows }, width, tier, budget)
}

/**
 * A collapsed injection opened in place: whose it is, which hook, how often
 * it fired and how much it added. `v` shows the most recent one's text, so
 * the count says which one that will be.
 */
function injectionDetailRows(g: ShownInjection, width: number, tier: Tier, budget: number): Row[] {
  const field = fieldOf(cardInner(width, tier))
  const many = g.count > 1
  const rows: Row[] = [
    field('plugin', 'plugin', [{ text: g.plugin }]),
    field('hook', 'hook', [{ text: g.hookName }]),
    field('count', 'injected', many ? [{ text: `${grouped(g.count)} times` }, { text: ', v shows the most recent', dim: true }] : [{ text: 'once' }]),
    field('size', 'size', [{ text: grouped(g.chars), color: HEADING }, { text: many ? ' chars in total' : ' chars', dim: true }]),
  ]
  return detailCard({ key: 'detail', title: g.hookName, subtitle: 'injection', body: rows }, width, tier, budget)
}

// ------------------------------------------------------------- the content

/** The fewest rows of text the content view keeps before it gives up the spacing around its title. */
const CONTENT_MIN = 3

/** How the content view uses a pane `columns` by `rows`: its tier, the cells a line of text gets, the card's spacing, and how many rows of text show. */
function contentGeometry(columns: number, rows: number): { width: number; tier: Tier; inner: number; text: number; density: Density; page: number } {
  const width = Math.max(0, Math.floor(columns))
  const budget = Math.max(0, heightOf(width, rows) - 1)
  const tier = tierOf(width)
  const inner = cardInner(width, tier)
  const head = (d: Density) => (d.gap ? 1 : 0) + 1 + (d.under ? 1 : 0)
  // The position line under the text takes one row.
  const density = DENSITIES.find(d => head(d) + 1 + CONTENT_MIN <= budget) ?? DENSITIES[DENSITIES.length - 1]!
  return { width, tier, inner, text: Math.max(1, inner - 1), density, page: Math.max(1, budget - head(density) - 1) }
}

/** The rows of text the content view shows at once in a pane `columns` by `rows`: what `n` and `p` page by. */
export function contentPage(columns: number, rows: number): number {
  return contentGeometry(columns, rows).page
}

/** Each line of the text cut into rows of `width` cells, each row remembering the line it came from. */
function contentLines(lines: string[], width: number): Array<{ text: string; line: number }> {
  return lines.flatMap((l, line) => {
    const parts = wrapCells(stripControl(l), width)
    return (parts.length === 0 ? [''] : parts).map(text => ({ text, line }))
  })
}

/**
 * `scroll` held inside the text: never before its first row, never so far
 * that the last page is not full. The mod stores only what this returns, so
 * `p` after scrolling past the end moves at once.
 */
export function contentScroll(input: { content: Content | null; columns: number; rows: number }, scroll: number): number {
  const { content } = input
  if (content === null || !('lines' in content)) return 0
  const g = contentGeometry(input.columns, input.rows)
  const total = contentLines(content.lines, g.text).length
  return Math.min(Math.max(0, Math.floor(scroll) || 0), Math.max(0, total - g.page))
}

/** `lines 41–80 of 212`, by the lines of the text the rows came from, not by the rows. */
function position(first: number, last: number, of: number): string {
  if (first === last) return `line ${first} of ${of}`
  return `lines ${first}–${last} of ${of}`
}

/**
 * The content view: the text of an item or an injection as a card titled
 * with it, the rows from `scroll`, where in the text they are, and a footer
 * of the keys that apply. Full width at every tier: reading wants the room
 * more than it wants the list beside it.
 */
function contentRows(model: ShownModel, view: Extract<View, { kind: 'content' }>, content: Content, columns: number, rows: number, feedback: string | null, note: string): Row[] {
  const g = contentGeometry(columns, rows)
  const height = heightOf(g.width, rows)
  const keys: Segment[][] = []
  let body: Row[]
  if ('lines' in content) {
    const all = contentLines(content.lines, g.text)
    const start = contentScroll({ content, columns, rows }, view.scroll)
    const shown = all.slice(start, start + g.page)
    if (start + g.page < all.length) keys.push([button({ kind: 'next' }, 'next', 'n')])
    if (start > 0) keys.push([button({ kind: 'previous' }, 'previous', 'p')])
    const first = shown[0]
    const last = shown[shown.length - 1]
    const at = first === undefined || last === undefined ? 'nothing to show' : `${position(first.line + 1, last.line + 1, content.lines.length)}${content.truncated ? ' · truncated' : ''}`
    body = [...shown.map((r, i): Row => ({ key: `content-${start + i}`, segments: [{ text: ' ' }, { text: r.text }] })), dimRow('content-at', ` ${at}`, g.inner)]
  } else if ('error' in content) {
    body = wrap(stripControl(content.error), g.text).map((line, i): Row => ({ key: `content-error-${i}`, segments: [{ text: ` ${line}`, dim: true }] }))
  } else {
    body = [dimRow('content-loading', ' Reading…', g.inner)]
  }
  keys.push([backKey()])
  const footer = footerRow(keys, note, feedback, g.width)
  if (height === 1) return [footer]
  const section: Section = { key: 'content', ...contentTitle(model, view, content), body }
  return pinned(cardLines(section, g.width, g.tier, g.density), height - 1, footer)
}

/** The content card's title: the item's file name or the injection's hook, as its detail names it; the text's own title when the model no longer has it. */
function contentTitle(model: ShownModel, target: Target, content: Content): { title: string; subtitle?: string } {
  if ('real' in target) {
    const item = [...model.instructions, ...model.memory].find(i => i.real === target.real)
    if (item !== undefined) return { title: baseName(item.path), subtitle: item.kind }
  } else {
    const g = model.injected.find(i => i.key === target.injection)
    if (g !== undefined) return { title: g.hookName, subtitle: 'injection' }
  }
  return { title: 'title' in content ? stripControl(content.title) : '…' }
}

/** The wide tier's right half with nothing to preview. */
function hintRows(width: number, empty: boolean): Row[] {
  const hint = empty ? '  No instruction files in this session.' : '  Nothing flagged. Press a file name to open it.'
  return [blankRow('hint-gap'), dimRow('hint', hint, width)]
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
