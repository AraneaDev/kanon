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
 *
 * An opened item is one view, full width: its details in a card, a rule,
 * then its text, windowed when it is longer than the room left. There the
 * text gives way before the card does (see `detailGeometry`).
 */
import type { InjectedGroup, PaneItem, PaneModel } from '../../src/model'
import { stripControl } from './control'
import { besideRows, cardInner, cardRows, FRAME, gridColumns, moreRows, type Section } from './cards'
import { MARK, mark, type Mark } from './marks'
import { ACCENT, HEADING } from './palette'
import { button, clip, dimRow, segmentsWidth, spread, walkedRow } from './rows'
import { cells, fit, fitStart, grouped, padEnd, pathParts, spaces, wrapCells } from './text'
import { tierOf, type Tier } from './tiers'
import type { Action, Row, Segment } from './types'

export type { Action, Row, Segment } from './types'
export { rowWidth } from './rows'

/** What a detail is about: an item by its realpath, or a collapsed injection by its key ({@link injectionKey}). */
export type Target = { real: string } | { injection: string }
/**
 * The list, or one item or injection opened in place: its details and, under
 * them, its text read from `scroll`, the first row of the text shown (0 when
 * absent). `b` goes back to the list in one step.
 *
 * The text was once a view of its own behind `v`. Live, the person opened an
 * item and then had to find a second key to see what it says: opening it now
 * shows both.
 */
export type View = { kind: 'list' } | ({ kind: 'detail'; scroll?: number } & Target)
/**
 * An item's text as `kanon show` printed it, independent of the model's
 * status: the lines, still reading, or why it could not be read.
 */
export type Content = { title: string; lines: string[]; truncated: boolean } | { loading: true } | { error: string }

/** The one string a target is known by, so the mod can tell whether the text it holds is the text of what is shown. */
export const targetKey = (t: Target): string => ('real' in t ? `real:${t.real}` : `injection:${t.injection}`)
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
  /**
   * The text of what the pane shows details of ({@link textTarget}): the
   * opened item, or the wide tier's previewed one. Null or absent reads as
   * still reading. The mod hands in only text it read for that target.
   */
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
  const content = input.content ?? { loading: true }
  const opened = openedOf(model, input.view)
  if (opened !== null) return detailView(opened, input.view.kind === 'detail' ? (input.view.scroll ?? 0) : 0, content, width, height, input.feedback, note)
  return listView(model, content, width, height, input.feedback, note)
}

/** An item or a collapsed injection, as a detail shows it. */
type Opened = { kind: 'item'; item: PaneItem } | { kind: 'injection'; group: ShownInjection }

/** What the view has open, as the model has it now; null for the list, or for an item the model no longer has (the list shows instead). */
function openedOf(model: ShownModel, view: View): Opened | null {
  if (view.kind !== 'detail') return null
  if ('real' in view) {
    const item = [...model.instructions, ...model.memory].find(i => i.real === view.real)
    return item === undefined ? null : { kind: 'item', item }
  }
  const group = model.injected.find(g => g.key === view.injection)
  return group === undefined ? null : { kind: 'injection', group }
}

/** The item the wide tier previews beside the list: the first flagged one. */
const previewOf = (model: ShownModel): PaneItem | null => [...model.instructions, ...model.memory].find(flagged) ?? null

/**
 * Whose text the pane shows at `columns`, so the mod knows what to read: the
 * opened item or injection at any tier, else in the wide tier the previewed
 * item, else none. The same decisions {@link layout} makes, from the same
 * input, so the two can never disagree about which text belongs where.
 */
export function textTarget(input: Pick<LayoutInput, 'status' | 'view' | 'columns'>): Target | null {
  if (input.status.kind !== 'ready') return null
  const model = shown(input.status.model)
  const opened = openedOf(model, input.view)
  if (opened !== null) return opened.kind === 'item' ? { real: opened.item.real } : { injection: opened.group.key }
  if (tierOf(Math.max(0, Math.floor(input.columns))) !== 'wide') return null
  const previewed = previewOf(model)
  return previewed === null ? null : { real: previewed.real }
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

/**
 * The list. The wide tier previews an item beside it, the first flagged one:
 * its details and the first lines of its text. Only there is there a marker,
 * an `o` that opens the previewed item, and an `a` for it; narrower, each
 * file name is its own open button.
 */
function listView(model: ShownModel, content: Content, width: number, height: number, feedback: string | null, note: string): Row[] {
  const items = [...model.instructions, ...model.memory]
  const tier = tierOf(width)
  const previewed = tier === 'wide' ? previewOf(model) : null
  const keys: Segment[][] = [
    ...(items.length + model.injected.length > 0 ? LIST_KEYS : []),
    ...(previewed !== null ? [[button({ kind: 'open', real: previewed.real }, 'open', 'o')], ...ackKey(previewed).map(k => [k])] : []),
  ]
  const footer = footerRow(keys, note, feedback, width)
  if (height === 1) return [footer]

  const budget = height - 1
  let body: Row[]
  if (tier === 'wide') {
    const [left, right] = gridColumns(width, LIST_SHARE)
    // A preview is read from its top: it has no keys to page it, so it never scrolls.
    const detail = previewed !== null ? detailBody({ kind: 'item', item: previewed }, 0, content, right, tier, budget).rows : hintRows(right, items.length === 0)
    body = besideRows(listRows(model, left, tier, budget, previewed?.real ?? null), detail, left)
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

const backKey = (): Segment => button({ kind: 'back' }, 'back', 'b')

/** `a: acknowledge`, for an item with a verdict not yet acknowledged; else nothing. */
const ackKey = (item: PaneItem): Segment[] => (item.verdict !== null && !item.acknowledged ? [button({ kind: 'ack', real: item.real }, 'acknowledge', 'a')] : [])

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

/** The name a card shows for an item: its file name. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** A detail's card with its fields and nothing under them yet: the title, the note, the labelled rows. */
function cardOf(opened: Opened, inner: number): Section {
  const field = fieldOf(inner)
  if (opened.kind === 'injection') {
    // Whose it is, which hook, how often it fired and how much it added; when
    // it fired more than once, the text under the card is its most recent.
    const g = opened.group
    const many = g.count > 1
    const rows: Row[] = [
      field('plugin', 'plugin', [{ text: g.plugin }]),
      field('hook', 'hook', [{ text: g.hookName }]),
      field('count', 'injected', many ? [{ text: `${grouped(g.count)} times` }] : [{ text: 'once' }]),
      field('size', 'size', [{ text: grouped(g.chars), color: HEADING }, { text: many ? ' chars in total' : ' chars', dim: true }]),
      ...(many ? [field('shown', 'shown', [{ text: `most recent of ${grouped(g.count)}` }])] : []),
    ]
    return { key: 'detail', title: g.hookName, subtitle: 'injection', body: rows }
  }
  // What the item is, where it came from, and for a flag its evidence and whether it was acknowledged.
  const item = opened.item
  const value = inner - 2 - LABEL_COLUMN
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
  return { key: 'detail', title: baseName(item.path), subtitle: item.kind, note, body: rows }
}

/** The fewest rows of text a detail keeps before it gives up the spacing around its title. */
const TEXT_MIN = 3

/** The text as rows of a card: each line cut into rows of `width` cells, each row remembering the line it came from; or the dim rows that stand in for it. */
type TextRows = { kind: 'lines'; all: Array<{ text: string; line: number }>; of: number; truncated: boolean } | { kind: 'note'; rows: Row[] }

function textRowsOf(content: Content, width: number): TextRows {
  if ('lines' in content) {
    if (content.lines.length === 0) return { kind: 'note', rows: [{ key: 'text-empty', segments: [{ text: ' nothing to show', dim: true }] }] }
    const all = content.lines.flatMap((l, line) => {
      const parts = wrapCells(stripControl(l), width)
      return (parts.length === 0 ? [''] : parts).map(text => ({ text, line }))
    })
    return { kind: 'lines', all, of: content.lines.length, truncated: content.truncated }
  }
  if ('error' in content) return { kind: 'note', rows: wrap(stripControl(content.error), width).map((line, i): Row => ({ key: `text-error-${i}`, segments: [{ text: ` ${line}`, dim: true }] })) }
  return { kind: 'note', rows: [{ key: 'text-loading', segments: [{ text: ' Reading…', dim: true }] }] }
}

/**
 * How a detail spends `budget` rows `width` wide: the card's spacing, the
 * rows left for the text under the rule, and how many of them are lines of
 * text (`page`, what `n` and `p` move by) when the text needs a position line
 * under it.
 *
 * The text gives way first. The spacing goes before the text drops under
 * {@link TEXT_MIN} rows; past that the text shrinks, then goes with its rule,
 * and only then is the card itself cut. A finding's evidence is never pushed
 * off the pane to make room for the file it is about.
 */
function detailGeometry(opened: Opened, content: Content, width: number, tier: Tier, budget: number) {
  const inner = cardInner(width, tier)
  const section = cardOf(opened, inner)
  const text = textRowsOf(content, Math.max(1, inner - 1))
  const need = text.kind === 'lines' ? text.all.length : text.rows.length
  const head = (d: Density) => (d.gap ? 1 : 0) + 1 + (d.under ? 1 : 0)
  // What is left under the card and its rule.
  const roomAt = (d: Density) => budget - head(d) - section.body.length - 1
  const density = DENSITIES.find(d => roomAt(d) >= Math.min(need, TEXT_MIN)) ?? DENSITIES[DENSITIES.length - 1]!
  const room = Math.max(0, roomAt(density))
  // Cut short, the text gives one of its rows to the line saying where it is, when it has a row to give.
  const positioned = text.kind === 'lines' && need > room && room >= 2
  const page = text.kind === 'lines' && need > room ? (positioned ? room - 1 : room) : need
  return { inner, section, text, density, room, page, positioned, total: text.kind === 'lines' ? text.all.length : 0 }
}

/** `scroll` held inside a text `total` rows long shown `page` at a time: never before its first row, never so far that the last page is not full. */
const clampScroll = (scroll: number, total: number, page: number): number => (page <= 0 ? 0 : Math.min(Math.max(0, Math.floor(scroll) || 0), Math.max(0, total - page)))

/** `lines 41–80 of 212`, by the lines of the text the rows came from, not by the rows. */
function position(first: number, last: number, of: number): string {
  if (first === last) return `line ${first} of ${of}`
  return `lines ${first}–${last} of ${of}`
}

/**
 * A detail's rows: the card, then a rule, then the text from `scroll` and,
 * when it is cut, where in it the rows are. With whether there is more text
 * after (`next`) and before (`previous`) what shows.
 */
function detailBody(opened: Opened, scroll: number, content: Content, width: number, tier: Tier, budget: number): { rows: Row[]; next: boolean; previous: boolean } {
  const g = detailGeometry(opened, content, width, tier, budget)
  let under: Row[] = []
  let next = false
  let previous = false
  if (g.room > 0) {
    const rule: Row = { key: 'detail-rule', segments: [{ text: '─'.repeat(g.inner), color: FRAME }] }
    let text: Row[]
    if (g.text.kind === 'lines') {
      const start = clampScroll(scroll, g.total, g.page)
      const shown = g.text.all.slice(start, start + g.page)
      next = start + g.page < g.total
      previous = start > 0
      text = shown.map((r, i): Row => ({ key: `text-${start + i}`, segments: [{ text: ' ' }, { text: r.text }] }))
      const first = shown[0]
      const last = shown[shown.length - 1]
      if (g.positioned && first !== undefined && last !== undefined) {
        text.push(dimRow('text-at', ` ${position(first.line + 1, last.line + 1, g.text.of)}${g.text.truncated ? ' · truncated' : ''}`, g.inner))
      }
    } else {
      text = g.text.rows.slice(0, g.room)
    }
    under = [rule, ...text]
  }
  const rows = cardLines({ ...g.section, body: [...g.section.body, ...under] }, width, tier, g.density).slice(0, budget)
  return { rows, next, previous }
}

/**
 * An item or injection opened in place, full width at every tier: reading
 * wants the room more than it wants the list beside it. The footer offers
 * `n` and `p` only where they move the text, `a` for an open flag, then `b`.
 */
function detailView(opened: Opened, scroll: number, content: Content, width: number, height: number, feedback: string | null, note: string): Row[] {
  const tier = tierOf(width)
  const budget = height - 1
  const body = detailBody(opened, scroll, content, width, tier, Math.max(0, budget))
  const keys: Segment[][] = [
    ...(body.next ? [[button({ kind: 'next' }, 'next', 'n')]] : []),
    ...(body.previous ? [[button({ kind: 'previous' }, 'previous', 'p')]] : []),
    ...(opened.kind === 'item' ? ackKey(opened.item).map(k => [k]) : []),
    [backKey()],
  ]
  const footer = footerRow(keys, note, feedback, width)
  if (height === 1) return [footer]
  return pinned(body.rows, budget, footer)
}

/** The input the text's paging depends on: what the mod keeps, at the size it last drew. */
type PagingInput = Pick<LayoutInput, 'status' | 'view' | 'columns' | 'rows'> & { content: Content | null }

/** The geometry of the opened detail's text at the drawn size; null where nothing is open. */
function pagingOf(input: PagingInput): ReturnType<typeof detailGeometry> | null {
  if (input.status.kind !== 'ready') return null
  const opened = openedOf(shown(input.status.model), input.view)
  if (opened === null) return null
  const width = Math.max(0, Math.floor(input.columns))
  return detailGeometry(opened, input.content ?? { loading: true }, width, tierOf(width), Math.max(0, heightOf(width, input.rows) - 1))
}

/** The rows of text an open detail shows at once at the drawn size: what `n` and `p` page by. */
export function contentPage(input: PagingInput): number {
  return Math.max(1, pagingOf(input)?.page ?? 1)
}

/**
 * `scroll` held inside the open detail's text, as the layout holds it. The
 * mod stores only what this returns, so `p` after scrolling past the end
 * moves at once.
 */
export function contentScroll(input: PagingInput, scroll: number): number {
  const g = pagingOf(input)
  return g === null || g.text.kind !== 'lines' ? 0 : clampScroll(scroll, g.total, g.page)
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
