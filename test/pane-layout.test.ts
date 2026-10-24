import { describe, expect, it } from 'bun:test'
import { contentPage, contentScroll, injectionKey, layout, rowWidth, textTarget, type LayoutInput, type Row, type Status, type View } from '../hooks/lib/layout'
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
  injected: [{ plugin: 'example', hookName: 'SessionStart', count: 1, chars: 9100, index: 0 }],
  skills: [],
  compactions: [{ t: '2026-01-01T10:00:00.000Z', trigger: 'auto', preTokens: 160000, postTokens: 40000 }],
  hooks: [],
  allSkills: [],
  agentMemory: [],
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
      '    example  SessionStart  ×1  9.1k chars'.padEnd(100),
      ' ',
      `── ◇ Skills ${dash(83)} 0 ──`,
      ' ',
      `── ◇ Compaction · 1 ${dash(78)}──`,
      blank(100),
      '    10:00  auto  160,000 → 40,000 tokens'.padEnd(100),
    ])
    expect(rows.slice(19, 39).every(r => text(r) === ' ')).toBe(true)
    expect(rows).toHaveLength(40)
    expect(text(rows[39]!)).toBe(` tab: move  enter: open${blank(68)}observed `)
  })

  it('counts an injection under 1,000 characters as itself, and from 1,000 in thousands with one decimal', () => {
    for (const [chars, shown] of [
      [42, '42 chars'],
      [999, '999 chars'],
      [1000, '1.0k chars'],
      [9100, '9.1k chars'],
    ] as const) {
      const rows = run({ model: { ...small, injected: [{ plugin: 'example', hookName: 'SessionStart', count: 1, chars, index: 0 }] } })
      expect(rows.map(text)).toContain(`    example  SessionStart  ×1  ${shown}`.padEnd(100))
    }
  })

  it('draws a collapsed injection as one row with its count, the count column as wide as the widest', () => {
    const injected = [
      { plugin: 'unattributed', hookName: 'UserPromptSubmit', count: 88, chars: 3520, index: 97 },
      { plugin: 'example', hookName: 'SessionStart', count: 1, chars: 900, index: 0 },
    ]
    const rows = run({ model: { ...small, injected } }).map(text)
    expect(rows).toContain(`── ◇ Injected by hooks · 2 ${dash(71)}──`)
    expect(rows).toContain('    unattributed  UserPromptSubmit  ×88  3.5k chars'.padEnd(100))
    expect(rows).toContain('    example       SessionStart      ×1   900 chars'.padEnd(100))
  })

  it('makes each file name a button that opens it, with no marker and no o outside the wide tier', () => {
    for (const columns of [60, 100]) {
      const rows = run({ columns })
      const names = rows.flatMap(r => r.segments).filter(s => s.press?.kind === 'open' && 'real' in s.press && s.hotkey === undefined)
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

  it('says in the list footer which keys work, at every tier: tab and enter, then o and a in the wide tier', () => {
    expect(text(run({ columns: 60 }).at(-1)!)).toBe(` tab: move  enter: open${blank(28)}observed `)
    expect(text(run({ columns: 100 }).at(-1)!)).toStartWith(' tab: move  enter: open ')
    const wide = run({ columns: 140, model: { ...small, instructions: [small.instructions[0]!] } }).at(-1)!
    expect(text(wide)).toStartWith(' tab: move  enter: open  o: open  a: acknowledge ')
    // tab and enter are the engine's keys, drawn as text in a key's colours; o and a are the pane's buttons.
    expect(wide.segments.filter(s => s.press !== undefined).map(s => s.hotkey)).toEqual(['o', 'a'])
    expect(wide.segments.find(s => s.text === 'tab')?.color).toBe('suggestion')
    // A list with nothing to open names no key for opening it; an injection alone can be opened.
    expect(text(run({ model: { ...small, instructions: [], memory: [], injected: [] } }).at(-1)!)).not.toContain('enter')
    expect(text(run({ model: { ...small, instructions: [], memory: [] } }).at(-1)!)).toContain('enter: open')
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


/** The footer of a pane `columns` wide: its keys, then the basis against the right edge. */
const footerText = (keys: string, columns = 100): string => ` ${keys}${blank(columns - 1 - keys.length - 'observed '.length)}observed `
const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
const textOf = (lines: string[], truncated = false) => ({ title: 'notes.md', lines, truncated })

describe('the detail view', () => {
  const detail = (model: PaneModel, real: string, over: Partial<LayoutInput> = {}) => run({ model, view: { kind: 'detail', real }, rows: 20, content: textOf(numbered(5)), ...over })
  const CARD = [
    ' ',
    `── ◇ notes.md · memory ${dash(67)} ▲ gone ──`,
    blank(100),
    '    path     ~/.claude/projects/-home-user-app/memory/notes.md'.padEnd(100),
    '    origin   user'.padEnd(100),
    '    reason   session_start'.padEnd(100),
    '    verdict  ▲ gone'.padEnd(100),
    '    evidence names scripts/deploy.sh, which no longer exists'.padEnd(100),
    '    state    not acknowledged'.padEnd(100),
  ]
  const RULE = `  ${dash(96)}  `

  it('shows the details, a rule, then the whole text when it fits, with no position line', () => {
    const rows = detail(small, NOTES)
    expect(rows.map(text)).toEqual([...CARD, RULE, ...numbered(5).map(l => `   ${l}`.padEnd(100)), ...Array.from({ length: 4 }, () => ' '), footerText('a: acknowledge  b: back')])
    const footer = rows.at(-1)!
    expect(footer.segments.find(s => s.hotkey === 'a')?.press).toEqual({ kind: 'ack', real: NOTES })
    expect(footer.segments.find(s => s.hotkey === 'b')?.press).toEqual({ kind: 'back' })
    expect(rows.find(r => r.key === 'detail-rule')?.segments.find(s => s.text.startsWith('─'))?.color).toBe('subtle')
  })

  it('windows a long text under the details, says where it is, and offers n', () => {
    const rows = detail(small, NOTES, { content: textOf(numbered(100)) })
    expect(rows.map(text)).toEqual([...CARD, RULE, ...numbered(8).map(l => `   ${l}`.padEnd(100)), '   lines 1–8 of 100'.padEnd(100), footerText('n: next  a: acknowledge  b: back')])
    expect(rows.find(r => r.key === 'text-at')?.segments.find(s => s.text.includes('lines'))?.dim).toBe(true)
    expect(rows.at(-1)!.segments.filter(s => s.press !== undefined).map(s => s.hotkey)).toEqual(['n', 'a', 'b'])
  })

  it('pages the text within its bounds while the details stay put', () => {
    const at = (scroll: number) => run({ view: { kind: 'detail', real: NOTES, scroll }, rows: 20, content: textOf(numbered(100)) }).map(text)
    const middle = at(8)
    expect(middle.slice(0, 10)).toEqual([...CARD, RULE])
    expect(middle.slice(10, 19)).toEqual([...numbered(16).slice(8).map(l => `   ${l}`.padEnd(100)), '   lines 9–16 of 100'.padEnd(100)])
    expect(middle.at(-1)).toBe(footerText('n: next  p: previous  a: acknowledge  b: back'))
    const end = at(10_000)
    expect(end.slice(0, 10)).toEqual([...CARD, RULE])
    expect(end[18]).toBe('   lines 93–100 of 100'.padEnd(100))
    expect(end.at(-1)).toBe(footerText('p: previous  a: acknowledge  b: back'))
    expect(at(-5)[10]).toBe('   line 1'.padEnd(100))
  })

  it('agrees with the mod about the page and the bounds', () => {
    const input = { status: ready(small), view: { kind: 'detail', real: NOTES } as View, content: textOf(numbered(100)), columns: 100, rows: 20 }
    expect(contentPage(input)).toBe(8)
    expect(contentScroll(input, 10_000)).toBe(92)
    expect(contentScroll(input, -3)).toBe(0)
    expect(contentScroll({ ...input, content: { loading: true } }, 5)).toBe(0)
    expect(contentScroll({ ...input, content: textOf(numbered(5)) }, 5)).toBe(0)
  })

  it('says it is reading, or why it could not, under the details', () => {
    const loading = detail(small, NOTES, { content: { loading: true } })
    expect(loading.slice(0, 10).map(text)).toEqual([...CARD, RULE])
    expect(text(loading[10]!)).toBe('   Reading…'.padEnd(100))
    expect(loading[10]!.segments.find(s => s.text.includes('Reading'))?.dim).toBe(true)
    expect(text(loading.at(-1)!)).toBe(footerText('a: acknowledge  b: back'))
    const failed = detail(small, NOTES, { content: { error: 'kanon could not read notes.md' } })
    expect(failed.slice(0, 10).map(text)).toEqual([...CARD, RULE])
    expect(failed[10]!.segments.find(s => s.text.includes('could not read'))?.dim).toBe(true)
    // Absent text reads as still reading, never as an empty file.
    expect(text(detail(small, NOTES, { content: null })[10]!)).toBe('   Reading…'.padEnd(100))
  })

  it('wraps a long line within the width and counts the lines of the text, not the rows', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const rows = detail(small, NOTES, { columns: 60, rows: 30, content: textOf(['short', long, 'end'], true) })
    for (const r of rows) expect(rowWidth(r)).toBeLessThanOrEqual(60)
    const shown = rows.map(text).map(t => t.trim())
    const first = shown.indexOf('short')
    const last = shown.indexOf('end')
    expect(first).toBeGreaterThan(0)
    expect(shown.slice(first + 1, last).join(' ').replace(/\s+/g, ' ')).toBe(long)
    expect(shown).not.toContain('lines 1–3 of 3 · truncated')
    const cut = detail(small, NOTES, { columns: 60, rows: 16, content: textOf(['short', long, 'end'], true) }).map(text).map(t => t.trim())
    expect(cut.some(t => /^lines 1–\d of 3 · truncated$/.test(t))).toBe(true)
  })

  it('strips control characters from the text', () => {
    const rows = detail(small, NOTES, { content: textOf(['bad\x1b[31m\rline']) })
    // eslint-disable-next-line no-control-regex
    for (const r of rows) expect(/[\u0000-\u001F\u007F-\u009F]/.test(text(r))).toBe(false)
  })

  it('offers no acknowledge for an acknowledged item', () => {
    const acked = { ...gone, acknowledged: true }
    const rows = detail({ ...small, memory: [acked] }, NOTES).map(text)
    expect(rows.some(t => t.includes('a: acknowledge'))).toBe(false)
    expect(rows.some(t => t.includes('state    ✓ acknowledged, still holds'))).toBe(true)
    expect(rows.at(-1)).toBe(footerText('b: back'))
  })

  it('offers no acknowledge for an item with no verdict', () => {
    const rows = detail(small, '/home/user/app/node_modules/pkg/CLAUDE.md').map(text)
    expect(rows.some(t => t.includes('a: acknowledge'))).toBe(false)
  })

  it('has no v anywhere: no key, no word, no action', () => {
    for (const view of [LIST, { kind: 'detail', real: NOTES } as View, { kind: 'detail', injection: injectionKey(small.injected[0]!) } as View])
      for (const columns of [60, 100, 140]) {
        const rows = run({ view, columns, content: textOf(numbered(100)) })
        const segments = rows.flatMap(r => r.segments)
        expect(segments.some(s => s.hotkey === 'v')).toBe(false)
        expect(segments.some(s => (s.press?.kind as string) === 'view')).toBe(false)
        expect(rows.map(text).some(t => t.includes('v: view') || t.includes('v shows'))).toBe(false)
      }
  })

  it('opens full width at every tier, the list gone', () => {
    for (const columns of [60, 100, 140]) {
      const rows = detail(small, NOTES, { columns }).map(text)
      expect(rows.some(t => t.includes('◇ Instructions'))).toBe(false)
      expect(rows[1]).toStartWith('── ◇ notes.md · memory ')
      expect(rows.some(t => t.trim() === 'line 5')).toBe(true)
    }
  })
})

describe('the wide preview', () => {
  it('shows the previewed item’s details and the first lines of its text beside the list', () => {
    const rows = run({ columns: 140, rows: 30, content: { title: 'CLAUDE.md', lines: numbered(100), truncated: false } })
    const right = rows.map(r => text(r).slice(64))
    expect(right.some(t => t.includes('◇ CLAUDE.md · instruction'))).toBe(true)
    expect(right.some(t => t.includes('origin   foreign'))).toBe(true)
    expect(right.some(t => t.trim() === 'line 1')).toBe(true)
    expect(right.some(t => /lines 1–\d+ of 100/.test(t))).toBe(true)
    // A preview is read, not paged: its footer offers no n or p.
    expect(rows.at(-1)!.segments.some(s => s.hotkey === 'n' || s.hotkey === 'p')).toBe(false)
  })

  it('says it is reading while the previewed text has not arrived', () => {
    expect(run({ columns: 140, rows: 30, content: null }).map(text).some(t => t.includes('Reading…'))).toBe(true)
  })

  it('names the text it shows: the opened item at any tier, the previewed item in the wide list, else none', () => {
    const at = (view: View, columns: number) => textTarget({ status: ready(small), view, columns })
    expect(at(LIST, 140)).toEqual({ real: '/home/user/app/node_modules/pkg/CLAUDE.md' })
    expect(at(LIST, 100)).toBeNull()
    expect(at({ kind: 'detail', real: NOTES }, 60)).toEqual({ real: NOTES })
    expect(at({ kind: 'detail', real: NOTES }, 140)).toEqual({ real: NOTES })
    expect(at({ kind: 'detail', injection: injectionKey(small.injected[0]!) }, 100)).toEqual({ injection: injectionKey(small.injected[0]!) })
    // An item no longer in the model falls back to the list, and so does its text.
    expect(at({ kind: 'detail', real: '/home/user/app/missing.md' }, 100)).toBeNull()
    expect(at({ kind: 'detail', real: '/home/user/app/missing.md' }, 140)).toEqual({ real: '/home/user/app/node_modules/pkg/CLAUDE.md' })
    expect(textTarget({ status: { kind: 'loading' }, view: { kind: 'detail', real: NOTES }, columns: 100 })).toBeNull()
    const quiet = { ...small, instructions: [small.instructions[0]!], memory: [] }
    expect(textTarget({ status: ready(quiet), view: LIST, columns: 140 })).toBeNull()
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
    injected: Array.from({ length: Math.min(n, 10) }, (_, i) => ({ plugin: `plugin-${i}`, hookName: 'SessionStart', count: 1, chars: 1000 * i, index: i })),
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
  const many = { title: 'CLAUDE.md', lines: Array.from({ length: 300 }, (_, i) => `${'long words here '.repeat(i % 12)}${i}`), truncated: true }
  const views: View[] = [LIST, { kind: 'detail', real: '/home/user/.claude/projects/app/memory/gone.md' }, { kind: 'detail', injection: injectionKey(model.injected[3]!) }]
  const contents = [many, { loading: true as const }, { error: 'kanon could not read the file' }]
  /** The field rows of a detail: everything its card holds above the rule. */
  const fields = (view: View): string[] =>
    layout({ status: ready(model), view, columns: 200, rows: 200, feedback: null, frame: 0, content: { loading: true } })
      .map(r => r.key)
      .filter(k => k.startsWith('detail-') && !['detail-head', 'detail-under', 'detail-rule'].includes(k))
  for (const columns of [40, 60, 80, 100, 130, 140, 200])
    for (const height of [8, 24, 60])
      for (const view of views)
        it(`${columns}x${height} ${view.kind}`, () => {
          const expected = view.kind === 'detail' ? fields(view) : []
          for (const content of contents)
            for (const scroll of [0, 50, 10_000]) {
              const v = view.kind === 'detail' ? { ...view, scroll } : view
              const rows = layout({ status: ready(model), view: v, columns, rows: height, feedback: null, frame: 0, content })
              for (const r of rows) expect(rowWidth(r)).toBeLessThanOrEqual(columns)
              expect(rows.length).toBeLessThanOrEqual(height)
              expect(rows.at(-1)!.key).toBe('footer')
              if (view.kind === 'detail') {
                expect(text(rows.at(-1)!)).toContain('b: back')
                // The text gives way first: a row of it shows only under every field of the card.
                if (rows.some(r => r.key.startsWith('text-'))) for (const k of expected) expect(rows.some(r => r.key === k)).toBe(true)
              }
              for (const [group, reals] of Object.entries(flagged)) {
                const shown = rows.some(r => r.key.includes(`${group}-head`) || r.key.includes(`${group}:`))
                if (shown) expect(rows.some(r => reals.some(real => r.key.includes(`${group}:${real}`)))).toBe(true)
              }
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

describe('text Kanon did not write', () => {
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001F\u007F-\u009F]/
  const EVIL_REAL = '/home/user/app/\x1b[31mevil\r.md'
  const evil: PaneModel = {
    ...small,
    instructions: [
      item({
        path: '\x1b[31mevil\r.md',
        real: EVIL_REAL,
        origin: 'foreign',
        reason: 'nested\x1b[2K_traversal',
        verdict: { level: 'gone', evidence: 'names \x1b[31mscripts/x.sh\r, which \x07is gone' },
      }),
    ],
    injected: [{ plugin: 'ex\x1bample', hookName: 'Session\rStart', count: 1, chars: 10, index: 0 }],
    skills: ['sk\x1b[0mill'],
    compactions: [{ t: '2026-01-01T10:00:00.000Z', trigger: 'au\rto', preTokens: 1, postTokens: 1 }],
  }

  for (const columns of [40, 100, 160]) {
    for (const view of [LIST, { kind: 'detail', real: EVIL_REAL } as View]) {
      it(`reaches no row with a control character, and widths hold (${columns}, ${view.kind})`, () => {
        const rows = run({ model: evil, columns, view })
        for (const r of rows) {
          expect(CONTROL.test(text(r))).toBe(false)
          expect(rowWidth(r)).toBeLessThanOrEqual(columns)
        }
      })
    }
  }

  it('keeps the realpath exact in the action a button carries', () => {
    const rows = run({ model: evil, columns: 160 })
    const actions = rows.flatMap(r => r.segments.flatMap(s => (s.press !== undefined && 'real' in s.press ? [s.press.real] : [])))
    expect(actions).toContain(EVIL_REAL)
  })

  it('strips an error reason', () => {
    const rows = layout({ status: { kind: 'error', reason: 'boom\x1b[2K\rfine' }, view: LIST, columns: 60, rows: 10, feedback: null, frame: 0 })
    for (const r of rows) expect(CONTROL.test(text(r))).toBe(false)
  })
})


describe('the injection detail', () => {
  const prompt = { plugin: 'unattributed', hookName: 'UserPromptSubmit', count: 88, chars: 3520, index: 97 }
  const once = { plugin: 'example', hookName: 'SessionStart', count: 1, chars: 900, index: 0 }
  const model: PaneModel = { ...small, injected: [prompt, once] }
  const said = { title: 'unattributed UserPromptSubmit', lines: ['Remember the house style.'], truncated: false }

  it('makes each injected row a button on its plugin name that opens its detail', () => {
    const presses = run({ model }).flatMap(r => r.segments).filter(s => s.press?.kind === 'open' && 'injection' in s.press)
    expect(presses.map(s => [s.text, s.press])).toEqual([
      ['unattributed', { kind: 'open', injection: injectionKey(prompt) }],
      ['example', { kind: 'open', injection: injectionKey(once) }],
    ])
  })

  it('names the plugin, the hook, how often and how much, which one it shows, then its text, with b to go back', () => {
    const rows = run({ model, view: { kind: 'detail', injection: injectionKey(prompt) }, rows: 12, content: said })
    expect(rows.map(text)).toEqual([
      ' ',
      `── ◇ UserPromptSubmit · injection ${dash(64)}──`,
      blank(100),
      '    plugin   unattributed'.padEnd(100),
      '    hook     UserPromptSubmit'.padEnd(100),
      '    injected 88 times'.padEnd(100),
      '    size     3,520 chars in total'.padEnd(100),
      '    shown    most recent of 88'.padEnd(100),
      `  ${dash(96)}  `,
      '   Remember the house style.'.padEnd(100),
      ' ',
      footerText('b: back'),
    ])
    expect(rows.at(-1)!.segments.filter(s => s.press !== undefined).map(s => [s.hotkey, s.press])).toEqual([['b', { kind: 'back' }]])
    const single = run({ model, view: { kind: 'detail', injection: injectionKey(once) }, rows: 12, content: said }).map(text)
    expect(single).toContain('    injected once'.padEnd(100))
    expect(single).toContain('    size     900 chars'.padEnd(100))
    expect(single.some(t => t.includes('most recent'))).toBe(false)
  })

  it('falls back to the list when the injection is no longer in the model', () => {
    const rows = run({ model, view: { kind: 'detail', injection: injectionKey({ plugin: 'gone', hookName: 'Stop' }) } })
    expect(rows.map(text).some(t => t.includes('◇ Instructions'))).toBe(true)
  })
})

/**
 * A hotkey works only while the pane holds the keyboard. Live, after Escape
 * or a click in the prompt, `b` went into the prompt and the pane seemed not
 * to go back at all. The footer says so instead of the basis.
 */
describe('focus', () => {
  it('a pane without the keyboard says how to give it, in place of the basis', () => {
    const footer = text(run({ focused: false }).at(-1)!)
    expect(footer).toContain('click the pane for its keys')
    expect(footer).not.toContain(small.basis)
  })
  it('a focused pane, or one that does not say, shows the basis', () => {
    expect(text(run({ focused: true }).at(-1)!)).toContain(small.basis)
    expect(text(run({}).at(-1)!)).toContain(small.basis)
  })
})
