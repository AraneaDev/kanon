import { describe, expect, test } from 'bun:test'
import { judge, scopeOf, type Item, type Probe } from '../src/stale'

const ROOT = '/home/user/proj'
const HOME = '/home/user'

function fake(o: {
  exist?: string[]
  code?: string[]
  scripts?: string[] | null
  changed?: string[]
}) {
  const calls = { exists: [] as string[], code: [] as string[][], changed: [] as Array<{ paths: string[]; since: Date }> }
  const probe: Probe = {
    exists: (p) => (calls.exists.push(p), (o.exist ?? []).includes(p)),
    occursInCode: (names) => (calls.code.push(names), new Set(names.filter((n) => (o.code ?? []).includes(n)))),
    scripts: () => (o.scripts === undefined ? new Set() : o.scripts === null ? null : new Set(o.scripts)),
    changedSince: (paths, since) => (calls.changed.push({ paths, since }), o.changed ?? []),
  }
  return { probe, calls }
}

const item = (text: string, over: Partial<Item> = {}): Item => ({
  path: `${ROOT}/CLAUDE.md`,
  origin: 'project',
  kind: 'instruction',
  written: new Date('2026-01-01'),
  text,
  ...over,
})

describe('scopeOf', () => {
  test('maps origin and kind to a scope', () => {
    expect(scopeOf(item('', { kind: 'memory', origin: 'user' }))).toBe('repo')
    expect(scopeOf(item('', { origin: 'project' }))).toBe('repo')
    expect(scopeOf(item('', { origin: 'local' }))).toBe('repo')
    expect(scopeOf(item('', { origin: 'user' }))).toBe('disk')
    expect(scopeOf(item('', { origin: 'managed' }))).toBe('none')
    expect(scopeOf(item('', { origin: 'foreign' }))).toBe('none')
  })
})

describe('judge', () => {
  test('scope none returns null without touching the probe', () => {
    const { probe, calls } = fake({})
    expect(judge(item('`src/a.ts`', { origin: 'foreign' }), ROOT, HOME, probe)).toBeNull()
    expect(calls.exists).toEqual([])
    expect(calls.code).toEqual([])
  })

  test('disk scope: a missing ~ path is gone', () => {
    const { probe, calls } = fake({})
    const v = judge(item('see `~/x/y.md`', { origin: 'user', path: `${HOME}/.claude/CLAUDE.md` }), ROOT, HOME, probe)
    expect(v).toEqual({ level: 'gone', evidence: 'names `~/x/y.md`, which no longer exists' })
    expect(calls.exists).toEqual([`${HOME}/x/y.md`])
  })

  test('disk scope: an existing absolute path gives no verdict', () => {
    const { probe } = fake({ exist: ['/opt/tool/a.md'] })
    expect(judge(item('`/opt/tool/a.md`', { origin: 'user' }), ROOT, HOME, probe)).toBeNull()
  })

  test('disk scope ignores relative paths, flags, symbols and scripts, and is never may-be-stale', () => {
    const { probe, calls } = fake({ changed: ['src/a.ts'] })
    const text = '`src/a.ts` `--verbose` `parseThing()` `bun run build`'
    expect(judge(item(text, { origin: 'user' }), ROOT, HOME, probe)).toBeNull()
    expect(calls.code).toEqual([])
    expect(calls.changed).toEqual([])
  })

  test('repo scope: relative path missing under both resolutions is gone', () => {
    const { probe } = fake({})
    expect(judge(item('`src/a.ts`'), ROOT, HOME, probe)).toEqual({
      level: 'gone',
      evidence: 'names `src/a.ts`, which no longer exists',
    })
  })

  test('repo scope: a path relative to the item directory counts as existing', () => {
    const { probe, calls } = fake({ exist: [`${ROOT}/.claude/rules/sub/a.md`] })
    const it = item('`sub/a.md`', { path: `${ROOT}/.claude/rules/r.md` })
    expect(judge(it, ROOT, HOME, probe)).toBeNull()
    expect(calls.changed[0]!.paths).toEqual(['.claude/rules/sub/a.md'])
  })

  test('repo scope: a path existing under the root is not gone', () => {
    const { probe } = fake({ exist: [`${ROOT}/src/a.ts`] })
    expect(judge(item('`src/a.ts`'), ROOT, HOME, probe)).toBeNull()
  })

  test('flag and symbol absent from code are gone; present are fine', () => {
    const gone = fake({})
    expect(judge(item('`--frobnicate`'), ROOT, HOME, gone.probe)).toEqual({
      level: 'gone',
      evidence: 'names `--frobnicate`, which no longer exists',
    })
    const sym = fake({})
    expect(judge(item('`parseThing()`'), ROOT, HOME, sym.probe)?.level).toBe('gone')
    const ok = fake({ code: ['--frobnicate', 'parseThing'] })
    expect(judge(item('`--frobnicate` `parseThing()`'), ROOT, HOME, ok.probe)).toBeNull()
  })

  test('script: missing is gone, present is fine, no package.json is ignored', () => {
    expect(judge(item('`bun run build`'), ROOT, HOME, fake({ scripts: ['test'] }).probe)).toEqual({
      level: 'gone',
      evidence: 'names `build`, which no longer exists',
    })
    expect(judge(item('`bun run build`'), ROOT, HOME, fake({ scripts: ['build'] }).probe)).toBeNull()
    expect(judge(item('`bun run build`'), ROOT, HOME, fake({ scripts: null }).probe)).toBeNull()
  })

  test('one batched occursInCode call per item', () => {
    const { probe, calls } = fake({ exist: [`${ROOT}/src/a.ts`] })
    judge(item('`--one` `--two` `parseThing()` `src/a.ts`'), ROOT, HOME, probe)
    expect(calls.code).toHaveLength(1)
    expect(calls.code[0]).toEqual(['--one', '--two', 'parseThing'])
  })

  test('the first gone name in extraction order wins', () => {
    const { probe } = fake({})
    const v = judge(item('`--first` and `src/second.ts`'), ROOT, HOME, probe)
    expect(v?.evidence).toBe('names `--first`, which no longer exists')
  })

  test('a slashless path missing on disk but present in code gives no verdict', () => {
    const { probe, calls } = fake({ code: ['process.env'] })
    expect(judge(item('reads `process.env` at start'), ROOT, HOME, probe)).toBeNull()
    expect(calls.code).toEqual([['process.env']])
  })

  test('a slashless path missing on disk and absent from code is gone', () => {
    const { probe } = fake({})
    expect(judge(item('see `notes.md`'), ROOT, HOME, probe)).toEqual({
      level: 'gone',
      evidence: 'names `notes.md`, which no longer exists',
    })
  })

  test('a path with a slash is judged by existence alone, not by code', () => {
    const { probe } = fake({ code: ['src/a.ts'] })
    expect(judge(item('`src/a.ts`'), ROOT, HOME, probe)?.level).toBe('gone')
  })

  test('a scoped package name is not checkable', () => {
    const { probe } = fake({})
    expect(judge(item('uses `@types/node` and `@scope/pkg/index.js`'), ROOT, HOME, probe)).toBeNull()
  })

  test('changed existing paths are may-be-stale, with a count of the rest', () => {
    const { probe, calls } = fake({
      exist: [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`],
      changed: ['src/a.ts', 'src/b.ts'],
    })
    const v = judge(item('`src/a.ts` `src/b.ts`'), ROOT, HOME, probe)
    expect(v).toEqual({ level: 'may-be-stale', evidence: '`src/a.ts` changed after this was written (and 1 more)' })
    expect(calls.changed).toHaveLength(1)
    expect(calls.changed[0]!.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(calls.changed[0]!.since).toEqual(new Date('2026-01-01'))
  })

  test('a single changed path has no "and more" suffix', () => {
    const { probe } = fake({ exist: [`${ROOT}/src/a.ts`], changed: ['src/a.ts'] })
    expect(judge(item('`src/a.ts`'), ROOT, HOME, probe)?.evidence).toBe('`src/a.ts` changed after this was written')
  })

  test('gone outranks may-be-stale and skips changedSince', () => {
    const { probe, calls } = fake({ exist: [`${ROOT}/src/a.ts`], changed: ['src/a.ts'] })
    expect(judge(item('`src/a.ts` `--gone`'), ROOT, HOME, probe)?.level).toBe('gone')
    expect(calls.changed).toEqual([])
  })

  test('no names, or prose only, gives no verdict', () => {
    const { probe } = fake({})
    expect(judge(item('Prefer small commits and/or short ones.'), ROOT, HOME, probe)).toBeNull()
    expect(judge(item('see `Object.keys` and `path.join`'), ROOT, HOME, probe)).toBeNull()
  })
})
