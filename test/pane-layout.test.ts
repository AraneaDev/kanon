import { describe, expect, it } from 'bun:test'
import { layout, rowWidth, type LayoutInput, type Row, type Status, type View } from '../hooks/lib/layout'
import type { PaneItem, PaneModel } from '../src/model'

const text = (row: Row): string => row.segments.map(s => s.text).join('')
const dash = (n: number): string => '─'.repeat(n)
const blank = (n: number): string => ' '.repeat(n)

const item = (over: Partial<PaneItem> & Pick<PaneItem, 'path' | 'real'>): PaneItem => ({
  kind: 'instruction',
  origin: 'project',
  reason: 'session_start',
  verdict: null,
  acknowledged: false,
  ...over,
})

const NOTES = '/home/user/.claude/projects/-home-user-app/memory/notes.md'
const gone = item({
  path: '~/.claude/projects/-home-user-app/memory/notes.md',
  real: NOTES,
  kind: 'memory',
  origin: 'user',
  verdict: { level: 'gone', evidence: 'names scripts/deploy.sh, which no longer exists' },
})

const small: PaneModel = {
  v: 1,
  root: '/home/user/app',
  basis: 'observed',
  ruleset: 'test',
  instructions: [
    item({ path: 'CLAUDE.md', real: '/home/user/app/CLAUDE.md' }),
    item({ path: 'node_modules/pkg/CLAUDE.md', real: '/home/user/app/node_modules/pkg/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal' }),
  ],
  memory: [gone],
  injected: [{ plugin: 'example', hookName: 'SessionStart', chars: 9100 }],
  skills: [],
  compactions: [{ t: '2026-01-01T10:00:00.000Z', trigger: 'auto', preTokens: 160000, postTokens: 40000 }],
}

const ready = (model: PaneModel): Status => ({ kind: 'ready', model })
const LIST: View = { kind: 'list' }
const run = (over: Partial<LayoutInput> & { model?: PaneModel }): Row[] => {
  const { model = small, ...rest } = over
  return layout({ status: ready(model), view: LIST, columns: 100, rows: 40, feedback: null, frame: 0, ...rest })
}

describe('the list', () => {
  it('lays a small model out as ruled cards at 100 columns, flagged first, the empty group one line', () => {
    const rows = run({})
    expect(rows.slice(0, 19).map(text)).toEqual([
      ' ',
      `── ◇ Instructions · 2 ${dash(63)} ! 1 foreign ──`,
      blank(100),
      '    ! foreign  node_modules/pkg/CLAUDE.md'.padEnd(100),
      '    ◦ project  CLAUDE.md'.padEnd(100),
      ' ',
      `── ◇ Memory · 1 ${dash(72)} ▲ 1 gone ──`,
      blank(100),
      '    ▲ ~/.claude/projects/-home-user-app/memory/notes.md'.padEnd(100),
      ' ',
      `── ◇ Injected by hooks · 1 ${dash(71)}──`,
      blank(100),
      '    example  SessionStart  9.1k chars'.padEnd(100),
      ' ',
      `── ◇ Skills ${dash(83)} 0 ──`,
      ' ',
      `── ◇ Compaction · 1 ${dash(78)}──`,
      blank(100),
      '    10:00  auto  160,000 → 40,000 tokens'.padEnd(100),
    ])
    expect(rows.slice(19, 39).every(r => text(r) === ' ')).toBe(true)
    expect(rows).toHaveLength(40)
    expect(text(rows[39]!)).toBe(`${blank(91)}observed `)
  })

  it('makes each file name a button that opens it, with no marker and no o outside the wide tier', () => {
    for (const columns of [60, 100]) {
      const rows = run({ columns })
      const names = rows.flatMap(r => r.segments).filter(s => s.press?.kind === 'open' && s.hotkey === undefined)
      expect(names.map(s => s.text)).toEqual(['CLAUDE.md', 'CLAUDE.md', 'notes.md'])
      expect(rows.flatMap(r => r.segments).some(s => s.hotkey !== undefined)).toBe(false)
      expect(rows.map(text).some(t => t.includes('›'))).toBe(false)
    }
  })

  it('in the wide tier marks the previewed item, o opens it, and a acknowledges it when it has an open verdict', () => {
    const marked = (rows: Row[]) => rows.map(text).filter(t => t.includes('›'))
    const foreign = run({ columns: 140 })
    expect(marked(foreign)).toHaveLength(1)
    expect(marked(foreign)[0]).toContain('› ! foreign  node_modules/pkg/CLAUDE.md')
    const keys = (rows: Row[]) => rows.at(-1)!.segments.filter(s => s.press !== undefined).map(s => [s.hotkey, s.press])
    expect(keys(foreign)).toEqual([['o', { kind: 'open', real: '/home/user/app/node_modules/pkg/CLAUDE.md' }]])
    const goneFirst = run({ columns: 140, model: { ...small, instructions: [small.instructions[0]!] } })
    expect(keys(goneFirst)).toEqual([
      ['o', { kind: 'open', real: NOTES }],
      ['a', { kind: 'ack', real: NOTES }],
    ])
  })

  it('draws the glyphs in their tones', () => {
    const seg = (glyph: string) => run({}).flatMap(r => r.segments).find(s => s.text === `${glyph} `)
    expect(seg('!')?.color).toBe('error')
    expect(seg('▲')?.color).toBe('warning')
    expect(seg('◦')?.dim).toBe(true)
  })

  it('narrow gives up the origin column before path folders', () => {
    const row = (columns: number) => run({ columns }).map(text).find(t => t.includes('pkg/CLAUDE.md') || t.includes('…/'))
    expect(row(100)).toContain('foreign  node_modules/pkg/CLAUDE.md')
    expect(row(60)).toContain('  ! node_modules/pkg/CLAUDE.md')
    expect(row(60)).not.toContain('foreign')
  })

  it('cuts a long path in its folders and keeps the file name', () => {
    const deep = item({ path: 'packages/example/very/deep/folder/structure/rules/CLAUDE.md', real: '/home/user/app/deep/CLAUDE.md', origin: 'foreign' })
    const rows = run({ columns: 40, model: { ...small, instructions: [deep] } })
    const line = rows.map(text).find(t => t.includes('CLAUDE.md'))!
    expect(line).toContain('…/')
    expect(line.trimEnd().endsWith('CLAUDE.md')).toBe(true)
  })

  it('puts feedback in the footer and keeps its keys', () => {
    const footer = text(run({ feedback: '✓ acknowledged', view: { kind: 'detail', real: NOTES } }).at(-1)!)
    expect(footer).toContain('b: back')
    expect(footer).toContain('✓ acknowledged')
    expect(footer).not.toContain('observed')
  })

  it('shows the first flagged item beside the list in the wide tier, else a dim hint', () => {
    const rows = run({ columns: 140 }).map(text)
    expect(rows.some(t => t.includes('◇ CLAUDE.md · instruction'))).toBe(true)
    expect(rows.some(t => t.includes('origin   foreign'))).toBe(true)
    const quiet = { ...small, instructions: [small.instructions[0]!], memory: [] }
    const rows2 = run({ columns: 140, model: quiet })
    const hint = rows2.find(r => text(r).includes('Nothing flagged'))
    expect(hint?.segments.some(s => s.dim)).toBe(true)
    expect(rows2.map(text).some(t => t.includes('›') || t.includes('o: open') || t.includes('marked'))).toBe(false)
    const empty = { ...small, instructions: [], memory: [] }
    const none = run({ columns: 140, model: empty }).map(text)
    expect(none.some(t => t.includes('No instruction files'))).toBe(true)
    expect(none.some(t => t.includes('o: open') || t.includes('marked'))).toBe(false)
  })

  it('falls back to the list when the opened item is no longer in the model', () => {
    const rows = run({ view: { kind: 'detail', real: '/home/user/app/missing.md' } })
    expect(text(rows.at(-1)!)).not.toContain('b: back')
    expect(rows.map(text).some(t => t.includes('◇ Instructions'))).toBe(true)
  })
})

describe('the detail view', () => {
  const detail = (model: PaneModel, real: string, columns = 100) => run({ model, view: { kind: 'detail', real }, columns, rows: 20 })

  it('shows a gone item with its evidence and offers to acknowledge it', () => {
    const rows = detail(small, NOTES)
    expect(rows.slice(0, 9).map(text)).toEqual([
      ' ',
      `── ◇ notes.md · memory ${dash(67)} ▲ gone ──`,
      blank(100),
      '    path     ~/.claude/projects/-home-user-app/memory/notes.md'.padEnd(100),
      '    origin   user'.padEnd(100),
      '    reason   session_start'.padEnd(100),
      '    verdict  ▲ gone'.padEnd(100),
      '    evidence names scripts/deploy.sh, which no longer exists'.padEnd(100),
      '    state    not acknowledged'.padEnd(100),
    ])
    expect(rows).toHaveLength(20)
    const footer = rows.at(-1)!
    expect(text(footer)).toBe(` a: acknowledge  b: back${blank(67)}observed `)
    expect(footer.segments.find(s => s.hotkey === 'a')?.press).toEqual({ kind: 'ack', real: NOTES })
    expect(footer.segments.find(s => s.hotkey === 'b')?.press).toEqual({ kind: 'back' })
  })

  it('offers no acknowledge for an acknowledged item', () => {
    const acked = { ...gone, acknowledged: true }
    const rows = detail({ ...small, memory: [acked] }, NOTES).map(text)
    expect(rows.some(t => t.includes('a: acknowledge'))).toBe(false)
    expect(rows.some(t => t.includes('state    ✓ acknowledged, still holds'))).toBe(true)
    expect(rows.at(-1)).toStartWith(' b: back')
  })

  it('offers no acknowledge for an item with no verdict', () => {
    const rows = detail(small, '/home/user/app/node_modules/pkg/CLAUDE.md').map(text)
    expect(rows.some(t => t.includes('a: acknowledge'))).toBe(false)
  })
})

describe('loading and errors', () => {
  it('reads as loading, never as an error', () => {
    const rows = layout({ status: { kind: 'loading' }, view: LIST, columns: 80, rows: 24, feedback: null, frame: 0 })
    const heading = rows.flatMap(r => r.segments).find(s => s.text.includes('Reading the session…'))
    expect(heading?.bold).toBe(true)
  })

  it('turns a spinner glyph by frame before the loading text', () => {
    const at = (frame: number) => text(layout({ status: { kind: 'loading' }, view: LIST, columns: 80, rows: 24, feedback: null, frame }).find(r => text(r).includes('Reading'))!)
    expect(at(0)).toBe(' ⠋ Reading the session…')
    expect(at(1)).toBe(' ⠙ Reading the session…')
    expect(at(10)).toBe(at(0))
  })

  it('shows a bold heading, a dim reason and one retry action', () => {
    const rows = layout({ status: { kind: 'error', reason: 'bun could not start' }, view: LIST, columns: 80, rows: 24, feedback: null, frame: 0 })
    const segments = rows.flatMap(r => r.segments)
    expect(segments.find(s => s.bold)).toBeDefined()
    expect(segments.find(s => s.text.includes('bun could not start'))?.dim).toBe(true)
    const actions = segments.filter(s => s.press !== undefined)
    expect(actions).toEqual([{ text: 'r: retry', press: { kind: 'retry' }, hotkey: 'r' }])
  })

  it('keeps the retry action in a pane one row tall', () => {
    const rows = layout({ status: { kind: 'error', reason: 'x' }, view: LIST, columns: 40, rows: 1, feedback: null, frame: 0 })
    expect(rows.map(text)).toEqual([' r: retry'])
  })
})

/** Many items, the flagged ones last in their input order, so only the sort can bring them up. */
function big(n: number): PaneModel {
  const instructions = Array.from({ length: n }, (_, i) =>
    item({ path: `.claude/rules/topic-${i}/rule-${i}.md`, real: `/home/user/app/.claude/rules/topic-${i}/rule-${i}.md` }),
  )
  instructions.push(item({ path: 'node_modules/example/CLAUDE.md', real: '/home/user/app/node_modules/example/CLAUDE.md', origin: 'foreign' }))
  instructions.push(item({ path: '.claude/rules/old.md', real: '/home/user/app/.claude/rules/old.md', verdict: { level: 'may-be-stale', evidence: '3 commits since' } }))
  const memory = Array.from({ length: n }, (_, i) =>
    item({ path: `~/.claude/projects/app/memory/note-${i}.md`, real: `/home/user/.claude/projects/app/memory/note-${i}.md`, kind: 'memory', origin: 'user' }),
  )
  memory.push({ ...gone, real: '/home/user/.claude/projects/app/memory/gone.md', path: '~/.claude/projects/app/memory/gone.md' })
  return {
    ...small,
    instructions,
    memory,
    injected: Array.from({ length: Math.min(n, 10) }, (_, i) => ({ plugin: `plugin-${i}`, hookName: 'SessionStart', chars: 1000 * i })),
    skills: Array.from({ length: Math.min(n, 5) }, (_, i) => `example:skill-${i}`),
    compactions: [{ t: '2026-01-01T10:00:00.000Z', trigger: 'auto', preTokens: 1000, postTokens: 100 }],
  }
}

describe('the width sweep', () => {
  const model = big(30)
  const flagged = {
    instructions: model.instructions.filter(i => i.origin === 'foreign' || i.verdict !== null).map(i => i.real),
    memory: model.memory.filter(i => i.verdict !== null).map(i => i.real),
  }
  const views: View[] = [LIST, { kind: 'detail', real: '/home/user/.claude/projects/app/memory/gone.md' }]
  for (const columns of [40, 60, 80, 100, 130, 140, 200])
    for (const height of [8, 24, 60])
      for (const view of views)
        it(`${columns}x${height} ${view.kind}`, () => {
          const rows = layout({ status: ready(model), view, columns, rows: height, feedback: null, frame: 0 })
          for (const r of rows) expect(rowWidth(r)).toBeLessThanOrEqual(columns)
          expect(rows.length).toBeLessThanOrEqual(height)
          expect(rows.at(-1)!.key).toBe('footer')
          if (view.kind === 'detail') expect(text(rows.at(-1)!)).toContain('b: back')
          for (const [group, reals] of Object.entries(flagged)) {
            const shown = rows.some(r => r.key.includes(`${group}-head`) || r.key.includes(`${group}:`))
            if (shown) expect(rows.some(r => reals.some(real => r.key.includes(`${group}:${real}`)))).toBe(true)
          }
        })
})

describe('a short, narrow pane', () => {
  /** 15 plain instructions, one foreign, one may be stale; 15 plain memories, one gone. */
  const crowded: PaneModel = (() => {
    const m = big(15)
    return { ...m, injected: m.injected.slice(0, 1), skills: m.skills.slice(0, 2) }
  })()
  const rows = layout({ status: ready(crowded), view: LIST, columns: 41, rows: 9, feedback: null, frame: 0 })

  it('shows every flagged item of every group it shows, dropping plain cards first', () => {
    for (const group of ['instructions', 'memory'] as const) {
      const shown = rows.some(r => r.key.startsWith(`${group}-head`) || r.key.startsWith(`${group}:`))
      expect(shown).toBe(true)
      for (const it of crowded[group].filter(i => i.origin === 'foreign' || i.verdict !== null)) expect(rows.some(r => r.key === `${group}:${it.real}`)).toBe(true)
    }
    expect(rows.length).toBeLessThanOrEqual(9)
  })

  it('keeps the flags in a narrow card header as glyph and count', () => {
    expect(rows.map(text).some(t => t.startsWith('── ◇ Instructions') && t.includes('≈ 1 · ! 1'))).toBe(true)
  })

  it('gives up the detail spacing before its content', () => {
    const detail = layout({ status: ready(crowded), view: { kind: 'detail', real: '/home/user/app/.claude/rules/old.md' }, columns: 41, rows: 9, feedback: null, frame: 0 }).map(text)
    expect(detail.some(t => t.includes('state'))).toBe(true)
  })
})

describe('the text budget', () => {
  it('stays under 90,000 characters for a 2,000-item model, however tall the pane', () => {
    const model = big(1000)
    for (const height of [60, 2000]) {
      const rows = layout({ status: ready(model), view: LIST, columns: 200, rows: height, feedback: null, frame: 0 })
      expect(rows.reduce((n, r) => n + text(r).length, 0)).toBeLessThanOrEqual(90000)
    }
  })
})
