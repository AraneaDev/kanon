import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

// Synthetic values only: the repository is public.
const ROOT = '/home/user/project'
const HOME = '/home/user'
const SESSION = 'session-1'
const PANE = 'kanon'
const NOTES = '/home/user/.claude/projects/-home-user-project/memory/notes.md'
/** A real path that a shell would split and expand: a space, a quote and a command substitution. */
const ODD = `/home/user/project/it's a $(x).md`

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ran = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const memoryItem = (real: string, path: string, gone: boolean) => ({
  path,
  real,
  kind: 'memory',
  origin: 'user',
  reason: 'session_start',
  verdict: gone ? { level: 'gone', evidence: 'names src/old.ts, which is not on disk' } : null,
  acknowledged: false,
})

/** What `kanon show` prints by default: a hundred numbered lines. */
const TEXT = JSON.stringify({ v: 1, title: 'notes.md', lines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`), truncated: false })

const modelJson = (memory: object[] = [memoryItem(NOTES, '~/.claude/projects/-home-user-project/memory/notes.md', true)]) =>
  JSON.stringify({ v: 1, root: ROOT, basis: 'observed', ruleset: 'r1', instructions: [], memory, injected: [], skills: [], compactions: [] })

const PANE_PROPS = {
  title: 'Kanon',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as RenderPropsOf['Pane']

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

/**
 * Stands in for the engine beneath the mod: the session, the panes it holds
 * open, the commands it registered, and every process the mod runs,
 * recorded. `model` answers `kanon model --json`, `bun` whether a bare `bun`
 * can start.
 */
function world(
  on: On,
  opts: {
    surfaces?: string[]
    refuseRegister?: () => boolean
    model?: () => Run | Promise<Run>
    bareBun?: boolean
    /** What a bare `bun` throws instead of running (a timeout, say); `bareBun: false` is ENOENT. */
    bunError?: Error
    /** Panes the engine already holds before anything runs (a pane left open across a hot reload). */
    heldPanes?: string[]
    /** Whether the engine places an opened pane. */
    placed?: boolean
    report?: Run
    /** Whether `ui.panes` is refused right now (no session bound yet, as after a hot reload). */
    panesRefused?: () => boolean
    /** What `kanon show` answers. */
    show?: () => Run | Promise<Run>
  } = {},
) {
  const clock = mock.clock(on)
  const registered: string[] = []
  const runs: string[][] = []
  const opened: string[] = []
  const closed: string[] = []
  const panes = new Set<string>(opts.heldPanes ?? [])
  let inFlight = 0
  let mostInFlight = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: (opts.surfaces ?? ['terminal']) as never }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => {
    if (opts.refuseRegister?.() === true) throw new Error('$.command.register is not available in this mode: no session is bound in this process')
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    if (opts.placed === false) return { value: { isPlaced: false, reason: 'no room' } as never }
    panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => {
    if (opts.panesRefused?.() === true) throw new Error('$.ui.panes is not available in this mode: no session is bound in this process')
    return { value: [...panes].map(id => ({ id, title: 'Kanon', isShown: true, isFocused: false, isPlaced: true })) }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    // A refusal is how the kit rejects the mod's call with a reason; a throw here would only skip this hook.
    if (argv[0] === 'bun' && opts.bareBun === false) return { deny: 'spawn bun ENOENT' }
    if (argv[0] === 'bun' && opts.bunError !== undefined) return { deny: opts.bunError.message }
    const sub = argv[2]
    if (sub === 'report') return { value: opts.report ?? ran('kanon report\n  LOADED  CLAUDE.md\n') }
    if (sub === 'ack') return { value: ran(`kanon: acknowledged ${argv[argv.length - 1]}\n`) }
    if (sub === 'show') return { value: await (opts.show ?? (() => ran(TEXT)))() }
    expect(sub, `a command the mod should not run: ${argv.join(' ')}`).toBe('model')
    inFlight++
    mostInFlight = Math.max(mostInFlight, inFlight)
    try {
      return { value: await (opts.model ?? (() => ran(modelJson())))() }
    } finally {
      inFlight--
    }
  })
  const modelRuns = () => runs.filter(r => r[2] === 'model')
  const showRuns = () => runs.filter(r => r[2] === 'show')
  return { clock, registered, runs, modelRuns, showRuns, opened, closed, panes, mostInFlight: () => mostInFlight }
}

async function slash($: Engine) {
  return $.command.run({ command: 'kanon', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
}

async function mountPane($: Engine, bodyColumns = 60) {
  return $.ui.mount({ plugin: 'kanon', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns } })
}

test('session.start registers /kanon', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  expect(w.registered).toEqual(['kanon'])
})

test('a refused first registration is retried and succeeds', async ($, on) => {
  let refusals = 1
  const w = world(on, { refuseRegister: () => refusals-- > 0 })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.registered).toEqual([])
  await w.clock.advance(1_000)
  expect(w.registered).toEqual(['kanon'])
  await w.clock.advance(60_000)
  expect(w.registered).toEqual(['kanon'])
})

test('a registration still refused after the timed retries is tried again at the end of a turn', async ($, on) => {
  let refusing = true
  const w = world(on, { refuseRegister: () => refusing })
  await $.session.start(START)
  await w.clock.advance(600_000)
  expect(w.registered).toEqual([])
  refusing = false
  await $.turn.complete(TURN)
  await w.clock.settle()
  expect(w.registered).toEqual(['kanon'])
})

test('where nothing can draw, /kanon prints the report and opens nothing', async ($, on) => {
  const w = world(on, { surfaces: [] })
  await $.session.start(START)
  const out = await slash($)
  await w.clock.settle()
  expect(out.text).toContain('LOADED  CLAUDE.md')
  expect(out.text?.startsWith('```')).toBe(true)
  expect(w.opened).toEqual([])
  expect(w.runs).toHaveLength(1)
  expect(w.runs[0]!.slice(2)).toEqual(['report', '--session', SESSION, '--cwd', ROOT])
})

test('/kanon opens the pane, a second run closes it, and two runs never leave two panes', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const first = await slash($)
  expect(first.text).toBeUndefined()
  expect(w.opened).toEqual([PANE])
  expect(w.panes.size).toBe(1)
  await slash($)
  expect(w.closed).toEqual([PANE])
  expect(w.panes.size).toBe(0)
  await slash($)
  await slash($)
  await slash($)
  expect(w.opened).toEqual([PANE, PANE, PANE])
  expect(w.panes.size).toBe(1)
})

test('an opened pane reads the model and draws the gone memory', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(1)
  const argv = w.modelRuns()[0]!
  expect(argv[0]).toBe('bun')
  expect(argv[1]!.endsWith('/src/cli.ts')).toBe(true)
  expect(argv.slice(2)).toEqual(['model', '--json', '--session', SESSION, '--cwd', ROOT])
  const ui = await mountPane($)
  const name = await ui.find({ type: 'Button', text: /notes\.md/ })
  expect(name).toBeDefined()
  const row = (await ui.findAll({ type: 'Box' })).find(b => typeof b.key === 'string' && b.key.endsWith(NOTES))
  expect(row?.text).toContain('▲')
  await ui.unmount()
})

test('a bun that cannot start is retried from ~/.bun/bin', async ($, on) => {
  const w = world(on, { bareBun: false })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  expect(w.modelRuns().map(r => r[0])).toEqual(['bun', `${HOME}/.bun/bin/bun`])
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await ui.unmount()
})

for (const [name, model] of [
  ['a rejecting', () => Promise.reject(new Error('timed out after 10000 ms'))],
  ['a garbage', () => ran('Segmentation fault\n')],
  ['an error-reporting', () => ran(`${JSON.stringify({ v: 1, error: 'no such directory' })}\n`)],
] as const) {
  test(`${name} model run draws the error heading and r: retry`, async ($, on) => {
    let fail = true
    const w = world(on, { model: () => (fail ? model() : ran(modelJson())) })
    await $.session.start(START)
    await slash($)
    await w.clock.settle()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /could not read the session/ })).toBeDefined()
    const retry = await ui.find({ type: 'Button', text: 'r: retry' })
    expect(retry).toBeDefined()
    fail = false
    await ui.press({ key: retry!.key! })
    await w.clock.settle()
    expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
    await ui.unmount()
  })
}

test('a model the layout cannot draw shows the error view, not an empty pane', async ($, on) => {
  // Passes parseModel (the lists are arrays), but the item has no path to draw.
  const w = world(on, { model: () => ran(modelJson([{ kind: 'memory', origin: 'user', verdict: null, acknowledged: false }])) })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  const ui = await mountPane($)
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text.trim()).join(' ')
  expect(shown).toMatch(/kanon\s+could\s+not\s+draw\s+the\s+pane/)
  await ui.unmount()
})

test('while the model is read, the pane turns a spinner', async ($, on) => {
  const w = world(on, { model: () => w.clock.sleep(5_000).then(() => ran(modelJson())) })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  const ui = await mountPane($)
  const before = (await ui.find({ type: 'Text', text: /^ \S $/ }))?.text
  expect(before).toBeDefined()
  await w.clock.advance(100)
  const after = (await ui.find({ type: 'Text', text: /^ \S $/ }))?.text
  expect(after).toBeDefined()
  expect(after).not.toBe(before)
  await w.clock.advance(5_000)
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await ui.unmount()
})

test('pressing a on a gone item runs kanon ack with the realpath as one argument, then says so for two seconds', async ($, on) => {
  const w = world(on, { model: () => ran(modelJson([memoryItem(ODD, "it's a $(x).md", true)])) })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  const ui = await mountPane($, 140)
  const ack = await ui.find({ type: 'Button', text: 'a: acknowledge' })
  expect(ack).toBeDefined()
  const before = w.modelRuns().length
  await ui.press({ key: ack!.key! })
  await w.clock.settle()
  const acks = w.runs.filter(r => r[2] === 'ack')
  expect(acks).toHaveLength(1)
  expect(acks[0]!.slice(-4)).toEqual(['ack', '--cwd', ROOT, ODD])
  expect(acks[0]!).toHaveLength(6)
  expect(await ui.find({ type: 'Text', text: /✓ acknowledged/ })).toBeDefined()
  expect(w.modelRuns().length).toBe(before + 1)
  await w.clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /✓ acknowledged/ })).toBeUndefined()
  await ui.unmount()
})

test('pressing a file name opens it in place, and b goes back to the list', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  const ui = await mountPane($)
  const name = await ui.find({ type: 'Button', text: /notes\.md/ })
  await ui.press({ key: name!.key! })
  expect(await ui.find({ type: 'Text', text: /evidence/ })).toBeDefined()
  const back = await ui.find({ type: 'Button', text: 'b: back' })
  expect(back).toBeDefined()
  await ui.press({ key: back!.key! })
  expect(await ui.find({ type: 'Text', text: /evidence/ })).toBeUndefined()
  await ui.unmount()
})

test('turn.complete refreshes only while the pane is open, and never an aborted turn', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(TURN)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(0)
  await slash($)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(1)
  await $.turn.complete(TURN)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(2)
  await $.turn.complete({ ...TURN, isAborted: true })
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(2)
  await slash($)
  await $.turn.complete(TURN)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(2)
})

test('a refresh never starts while another is in flight', async ($, on) => {
  const w = world(on, { model: () => w.clock.sleep(3_000).then(() => ran(modelJson())) })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(1)
  await w.clock.advance(10_000)
  expect(w.mostInFlight()).toBe(1)
  // The turns that ended during the read are answered by one more read after it, never two at once.
  expect(w.modelRuns()).toHaveLength(2)
})

test('a pane the engine still holds when the session starts (a hot reload) is read at once, with no turn', async ($, on) => {
  const w = world(on, { heldPanes: [PANE] })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(1)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await ui.unmount()
})

test('a held pane is adopted when a refused registration finally lands', async ($, on) => {
  // Right after a hot reload nothing is bound yet: the registration and the pane listing are both refused at start.
  let unbound = true
  const w = world(on, { refuseRegister: () => unbound, panesRefused: () => unbound, heldPanes: [PANE] })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(0)
  unbound = false
  await w.clock.advance(1_000)
  expect(w.registered).toEqual(['kanon'])
  expect(w.modelRuns()).toHaveLength(1)
})

// The kit cannot raise the person's close (its `$.ui` carries no `close`), so this closes through /kanon, whose
// `$.ui.close` runs the same `ui.close` chain, origin `plugin`, that the person's close mark runs with origin `person`.
test('a closed pane stops its spinner and drops a read that lands after', async ($, on) => {
  const w = world(on, { model: () => w.clock.sleep(5_000).then(() => ran(modelJson())) })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  await slash($)
  const ui = await mountPane($)
  const spun = (await ui.find({ type: 'Text', text: /^ \S $/ }))?.text
  await w.clock.advance(300)
  expect((await ui.find({ type: 'Text', text: /^ \S $/ }))?.text).toBe(spun)
  await w.clock.advance(5_000)
  // The read that landed after the close is not shown: the pane, if drawn, still reads as fresh.
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeUndefined()
  await ui.unmount()
})

test('a pane the engine did not place is not taken for open', async ($, on) => {
  const w = world(on, { placed: false })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  expect(w.modelRuns()).toHaveLength(0)
  await slash($)
  expect(w.opened).toEqual([PANE, PANE])
})

test('a bare bun rejected for a reason the mod does not recognise is retried from ~/.bun/bin', async ($, on) => {
  // $.process.run rejects only when the runtime cannot start or times out, and its wording is not a contract.
  const w = world(on, { bunError: new Error('the runtime could not be launched') })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  expect(w.modelRuns().map(r => r[0])).toEqual(['bun', `${HOME}/.bun/bin/bun`])
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await ui.unmount()
})

test('a bare bun that timed out is not run again from ~/.bun/bin', async ($, on) => {
  const w = world(on, { bunError: new Error('process timed out after 10000 ms') })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  expect(w.modelRuns().map(r => r[0])).toEqual(['bun'])
  const ui = await mountPane($)
  // The reason wraps across rows: read it whole.
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text.trim()).join(' ')
  expect(shown).toMatch(/timed\s+out after 10000 ms/)
  await ui.unmount()
})

test('a report that crashed says why instead of printing an empty fence', async ($, on) => {
  const w = world(on, { surfaces: [], report: { exitCode: 1, stdout: '', stderr: 'error: \x1b[31mModule not found\n', isStdoutTruncated: false, isStderrTruncated: false } })
  await $.session.start(START)
  const out = await slash($)
  await w.clock.settle()
  expect(out.text).toContain('Module not found')
  expect(out.text).not.toContain('```')
  expect(out.text).not.toContain('\x1b')
})

// ------------------------------------------------------- reading an item

/** Opens the pane, presses the file name, then `v`: the text of the memory, read. */
async function openText($: Engine, w: ReturnType<typeof world>) {
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  const ui = await mountPane($)
  const name = await ui.find({ type: 'Button', text: /notes\.md|it's a/ })
  await ui.press({ key: name!.key! })
  const v = await ui.find({ type: 'Button', text: 'v: view' })
  expect(v).toBeDefined()
  await ui.press({ key: v!.key! })
  await w.clock.settle()
  return ui
}

const SCROLL = { component: 'Pane', requestId: PANE, offset: 0, bodyRows: 30, contentRows: 30, origin: { kind: 'person' }, pointer: { row: 5, column: 5 } } as const

test('v runs kanon show with the realpath as one argument and draws the text, and n and p page it by the visible height', async ($, on) => {
  const w = world(on, { model: () => ran(modelJson([memoryItem(ODD, "it's a $(x).md", true)])) })
  const ui = await openText($, w)
  expect(w.showRuns()).toHaveLength(1)
  expect(w.showRuns()[0]!.slice(2)).toEqual(['show', '--cwd', ROOT, '--path', ODD])
  expect(w.showRuns()[0]!).toHaveLength(7)
  // 30 rows: the footer, the gap, title and the row under it, the position line: 25 lines of text.
  expect(await ui.find({ type: 'Text', text: /lines 1–25 of 100/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'p: previous' })).toBeUndefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'n: next' }))!.key! })
  expect(await ui.find({ type: 'Text', text: /lines 26–50 of 100/ })).toBeDefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'n: next' }))!.key! })
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'n: next' }))!.key! })
  // The last page is full: it ends at the last line, and there is no n past it.
  expect(await ui.find({ type: 'Text', text: /lines 76–100 of 100/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'n: next' })).toBeUndefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'p: previous' }))!.key! })
  expect(await ui.find({ type: 'Text', text: /lines 51–75 of 100/ })).toBeDefined()
  await ui.unmount()
})

test('an injected row opens its detail, and v shows its most recent injection by the index the model gave it', async ($, on) => {
  const injected = [{ plugin: 'unattributed', hookName: 'UserPromptSubmit', count: 3, chars: 120, index: 7 }]
  const model = JSON.stringify({ v: 1, root: ROOT, basis: 'observed', ruleset: 'r1', instructions: [], memory: [], injected, skills: [], compactions: [] })
  const w = world(on, { model: () => ran(model), show: () => ran(JSON.stringify({ v: 1, title: 'unattributed UserPromptSubmit', lines: ['Remember the house style.'], truncated: false })) })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'unattributed' }))!.key! })
  expect(await ui.find({ type: 'Text', text: /most recent/ })).toBeDefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'v: view' }))!.key! })
  await w.clock.settle()
  expect(w.showRuns().map(r => r.slice(2))).toEqual([['show', '--cwd', ROOT, '--session', SESSION, '--injection', '7']])
  expect(await ui.find({ type: 'Text', text: /Remember the house style\./ })).toBeDefined()
  await ui.unmount()
})

test('the wheel over the text scrolls it, held inside it', async ($, on) => {
  const w = world(on)
  const ui = await openText($, w)
  await $.ui.scroll({ ...SCROLL, by: 3 })
  expect(await ui.find({ type: 'Text', text: /lines 4–28 of 100/ })).toBeDefined()
  await $.ui.scroll({ ...SCROLL, by: -10 })
  expect(await ui.find({ type: 'Text', text: /lines 1–25 of 100/ })).toBeDefined()
  await $.ui.scroll({ ...SCROLL, by: 500 })
  expect(await ui.find({ type: 'Text', text: /lines 76–100 of 100/ })).toBeDefined()
  await ui.unmount()
})

test('b steps back one level at a time: the text to the detail, the detail to the list', async ($, on) => {
  const w = world(on)
  const ui = await openText($, w)
  expect(await ui.find({ type: 'Text', text: /lines 1–25/ })).toBeDefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'b: back' }))!.key! })
  expect(await ui.find({ type: 'Text', text: /lines 1–25/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /evidence/ })).toBeDefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'b: back' }))!.key! })
  expect(await ui.find({ type: 'Text', text: /evidence/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'b: back' })).toBeUndefined()
  await ui.unmount()
})

test('text that arrives after the person went back is not shown, and a closed pane forgets the text', async ($, on) => {
  const w = world(on, { show: () => w.clock.sleep(3_000).then(() => ran(TEXT)) })
  await $.session.start(START)
  await slash($)
  await w.clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: (await ui.find({ type: 'Button', text: /notes\.md/ }))!.key! })
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'v: view' }))!.key! })
  expect(await ui.find({ type: 'Text', text: /Reading…/ })).toBeDefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'b: back' }))!.key! })
  await w.clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: /lines 1–25/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /evidence/ })).toBeDefined()
  // Into the text again, then the pane closes and opens: it starts from the list.
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'v: view' }))!.key! })
  await w.clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: /lines 1–25/ })).toBeDefined()
  await slash($)
  await slash($)
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /lines 1–25/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await ui.unmount()
})
