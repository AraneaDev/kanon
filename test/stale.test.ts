import { describe, expect, test } from 'bun:test'
import { judge, scopeOf, type Item, type Probe } from '../src/stale'

const ROOT = '/home/user/proj'
const HOME = '/home/user'

function fake(o: {
  exist?: string[]
  code?: string[]
  scripts?: string[] | null
  changed?: string[]
  /** Repo-relative tracked paths; empty (known, nothing tracked) by default, null for unknown. */
  tracked?: string[] | null
  /** Names git ignores; none by default. */
  ignored?: string[]
}) {
  const calls = {
    exists: [] as string[],
    code: [] as string[][],
    changed: [] as Array<{ paths: string[]; since: Date }>,
    ignored: [] as string[][],
  }
  const probe: Probe = {
    exists: (p) => (calls.exists.push(p), (o.exist ?? []).includes(p)),
    occursInCode: (names) => (calls.code.push(names), new Set(names.filter((n) => (o.code ?? []).includes(n)))),
    scripts: () => (o.scripts === undefined ? new Set() : o.scripts === null ? null : new Set(o.scripts)),
    changedSince: (paths, since) => (calls.changed.push({ paths, since }), o.changed ?? []),
    trackedPaths: () => (o.tracked === null ? null : (o.tracked ?? [])),
    ignored: (paths) => (calls.ignored.push(paths), new Set(paths.filter((p) => (o.ignored ?? []).includes(p)))),
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

  /** A missing function or flag may be a rename the note predates; it is never `gone`. */
  test('flag and symbol absent from code are may-be-stale; present are fine', () => {
    const flag = fake({})
    expect(judge(item('`--frobnicate`'), ROOT, HOME, flag.probe)).toEqual({
      level: 'may-be-stale',
      evidence: 'names `--frobnicate`, which no longer occurs in the code',
    })
    const sym = fake({})
    expect(judge(item('`parseThing()`'), ROOT, HOME, sym.probe)).toEqual({
      level: 'may-be-stale',
      evidence: 'names `parseThing`, which no longer occurs in the code',
    })
    const ok = fake({ code: ['--frobnicate', 'parseThing'] })
    expect(judge(item('`--frobnicate` `parseThing()`'), ROOT, HOME, ok.probe)).toBeNull()
  })

  test('script: missing is may-be-stale, present is fine, no package.json is ignored', () => {
    expect(judge(item('`bun run build`'), ROOT, HOME, fake({ scripts: ['test'] }).probe)).toEqual({
      level: 'may-be-stale',
      evidence: 'names script `build`, which package.json no longer defines',
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

  test('a gone path wins over an earlier missing flag', () => {
    const { probe } = fake({})
    const v = judge(item('`--first` and `src/second.ts`'), ROOT, HOME, probe)
    expect(v).toEqual({ level: 'gone', evidence: 'names `src/second.ts`, which no longer exists' })
  })

  test('the first missing symbol, flag or script in extraction order gives may-be-stale', () => {
    const { probe } = fake({ scripts: ['test'] })
    const v = judge(item('`bun run build` then `--first` and `parseThing()`'), ROOT, HOME, probe)
    expect(v?.evidence).toBe('names script `build`, which package.json no longer defines')
  })

  test('a missing symbol wins over a changed file', () => {
    const { probe } = fake({ exist: [`${ROOT}/src/a.ts`], changed: ['src/a.ts'] })
    const v = judge(item('`src/a.ts` and `parseThing()`'), ROOT, HOME, probe)
    expect(v).toEqual({ level: 'may-be-stale', evidence: 'names `parseThing`, which no longer occurs in the code' })
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

  /** A file named by its basename is usually somewhere in the tree, not at the root. */
  test('a slashless name tracked elsewhere in the repo gives no verdict', () => {
    const { probe } = fake({ tracked: ['src/normalise.ts', 'src/cli.ts'] })
    expect(judge(item('the only file naming payload fields is `normalise.ts`'), ROOT, HOME, probe)).toBeNull()
  })

  test('a slashless name tracked nowhere and absent from code is gone', () => {
    const { probe } = fake({ tracked: ['src/cli.ts', 'src/xgone.ts'] })
    expect(judge(item('see `gone.ts`'), ROOT, HOME, probe)).toEqual({
      level: 'gone',
      evidence: 'names `gone.ts`, which no longer exists',
    })
  })

  /** Not knowing what is tracked is a tooling failure, and that never reads as gone. */
  test('a slashless name gives no verdict when the tracked set is unknown', () => {
    const { probe } = fake({ tracked: null })
    expect(judge(item('see `gone.ts`'), ROOT, HOME, probe)).toBeNull()
  })

  /** A relative path is often written from inside the tree (`discover/walk.ts` for `src/discover/walk.ts`). */
  test('a relative path tracked as the trailing segments of a deeper path gives no verdict', () => {
    const { probe } = fake({ tracked: ['src/discover/walk.ts'] })
    expect(judge(item('see `discover/walk.ts`'), ROOT, HOME, probe)).toBeNull()
  })

  test('a relative path matches tracked paths by whole segments only', () => {
    const { probe } = fake({ tracked: ['src/rediscover/walk.ts', 'src/discover/walk.tsx'] })
    expect(judge(item('see `discover/walk.ts`'), ROOT, HOME, probe)).toEqual({
      level: 'gone',
      evidence: 'names `discover/walk.ts`, which no longer exists',
    })
  })

  /** `specs/` names every `specs/` directory in the tree, wherever it sits. */
  test('a directory name contained in a tracked path gives no verdict', () => {
    const root = fake({ tracked: ['specs/a.md'] })
    expect(judge(item('under `specs/`'), ROOT, HOME, root.probe)).toBeNull()
    const deep = fake({ tracked: ['.claude/specs/sub/a.md'] })
    expect(judge(item('under `specs/` and `specs/sub/`'), ROOT, HOME, deep.probe)).toBeNull()
  })

  test('a directory name matches tracked paths by whole segments only', () => {
    const { probe } = fake({ tracked: ['src/myspecs/a.md', 'specs.md', 'x/specsets/b.md'] })
    expect(judge(item('under `specs/`'), ROOT, HOME, probe)).toEqual({
      level: 'gone',
      evidence: 'names `specs/`, which no longer exists',
    })
  })

  /** `lexer/parser/AST`, `vitest/config`, `fix/branch`, `Owner/Repo`: a list or a name, not a path here. */
  test('an extensionless name whose first segment is no tracked directory gives no verdict', () => {
    const { probe } = fake({ tracked: ['src/a.ts', 'docs/x.md'] })
    const text = '`lexer/parser/AST` `vitest/config` `fix/some-branch` `Owner/Repo` `./a/b/c` `X_/Y_=false`'
    expect(judge(item(text), ROOT, HOME, probe)).toBeNull()
  })

  test('an extensionless name under a tracked directory is still judged', () => {
    const { probe } = fake({ tracked: ['src/a.ts', 'lib/deep/x.ts'] })
    expect(judge(item('see `src/gone`'), ROOT, HOME, probe)?.evidence).toBe('names `src/gone`, which no longer exists')
    expect(judge(item('see `deep/gone`'), ROOT, HOME, probe)?.evidence).toBe('names `deep/gone`, which no longer exists')
  })

  test('a name with an extension is judged whatever its first segment', () => {
    const { probe } = fake({ tracked: ['src/a.ts'] })
    expect(judge(item('see `docs/gone.md`'), ROOT, HOME, probe)?.level).toBe('gone')
  })

  /** `.superpowers/` in a rule about where working files go: ignored, so never there to find. */
  test('a directory name git ignores gives no verdict, one ignore check per item', () => {
    const { probe, calls } = fake({ tracked: ['src/a.ts'], ignored: ['.superpowers/', 'out/'] })
    expect(judge(item('keep `.superpowers/` and `out/` out of commits'), ROOT, HOME, probe)).toBeNull()
    expect(calls.ignored).toEqual([['.superpowers/', 'out/']])
  })

  test('a directory name git does not ignore is still gone', () => {
    const { probe } = fake({ tracked: ['src/a.ts'], ignored: ['out/'] })
    expect(judge(item('see `out/` and `build/`'), ROOT, HOME, probe)?.evidence).toBe('names `build/`, which no longer exists')
  })

  /** A pointer to one ignored file is a claim that it is there; only directories are exempt. */
  test('an ignored file name is still gone', () => {
    const { probe, calls } = fake({ tracked: ['src/a.ts'], ignored: ['docs/plan.md'] })
    expect(judge(item('see `docs/plan.md`'), ROOT, HOME, probe)?.level).toBe('gone')
    expect(calls.ignored).toEqual([])
  })

  test('a relative path gives no verdict when the tracked set is unknown', () => {
    const { probe } = fake({ tracked: null })
    expect(judge(item('see `src/gone.ts` and `gone/`'), ROOT, HOME, probe)).toBeNull()
  })

  test('a pinned path is judged by disk alone, whatever is tracked', () => {
    const { probe } = fake({ tracked: ['home/user/x/y.md', 'x/y.md'] })
    expect(judge(item('see `~/x/y.md`'), ROOT, HOME, probe)?.level).toBe('gone')
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
    expect(judge(item('`src/a.ts` `src/gone.ts`'), ROOT, HOME, probe)?.level).toBe('gone')
    expect(calls.changed).toEqual([])
  })

  test('no names, or prose only, gives no verdict', () => {
    const { probe } = fake({})
    expect(judge(item('Prefer small commits and/or short ones.'), ROOT, HOME, probe)).toBeNull()
    expect(judge(item('see `Object.keys` and `path.join`'), ROOT, HOME, probe)).toBeNull()
  })
  test('repo scope: a missing ~ path or absolute path is gone by existence alone', () => {
    const a = fake({ code: ['~/x/y.md'] })
    expect(judge(item('`~/x/y.md`'), ROOT, HOME, a.probe)).toEqual({
      level: 'gone',
      evidence: 'names `~/x/y.md`, which no longer exists',
    })
    expect(a.calls.exists).toEqual([`${HOME}/x/y.md`])
    expect(a.calls.code).toEqual([])
    const b = fake({ code: ['/opt/gone/a.ts'] })
    expect(judge(item('`/opt/gone/a.ts`'), ROOT, HOME, b.probe)?.level).toBe('gone')
    expect(b.calls.code).toEqual([])
  })

  test('repo scope: an existing absolute path inside root that changed is may-be-stale', () => {
    const { probe, calls } = fake({ exist: [`${ROOT}/src/a.ts`], changed: ['src/a.ts'] })
    expect(judge(item(`\`${ROOT}/src/a.ts\``), ROOT, HOME, probe)).toEqual({
      level: 'may-be-stale',
      evidence: '`src/a.ts` changed after this was written',
    })
    expect(calls.changed[0]!.paths).toEqual(['src/a.ts'])
  })

  test('an existing absolute path outside root gives no verdict', () => {
    const { probe, calls } = fake({ exist: ['/opt/tool/a.md'] })
    expect(judge(item('`/opt/tool/a.md`'), ROOT, HOME, probe)).toBeNull()
    expect(calls.changed).toEqual([])
  })

  test('a probe that throws never produces a verdict', () => {
    const base = fake({ exist: [`${ROOT}/src/a.ts`] }).probe
    const text = '`src/a.ts` `--flag`'
    expect(judge(item(text), ROOT, HOME, { ...base, occursInCode: () => { throw new Error('rg died') } })).toBeNull()
    expect(judge(item('`src/b.ts`'), ROOT, HOME, { ...base, exists: () => { throw new Error('EACCES') } })).toBeNull()
    expect(judge(item('`bun run x`'), ROOT, HOME, { ...base, scripts: () => { throw new Error('bad json') } })).toBeNull()
    expect(judge(item('`src/a.ts`'), ROOT, HOME, { ...base, changedSince: () => { throw new Error('git died') } })).toBeNull()
    expect(judge(item('`~/x.md`', { origin: 'user' }), ROOT, HOME, { ...base, exists: () => { throw new Error('EIO') } })).toBeNull()
  })

  test('a memory item is judged with repo scope', () => {
    const { probe } = fake({})
    const it = item('`src/a.ts`', { kind: 'memory', origin: 'user', path: `${HOME}/.claude/projects/p/memory/m.md` })
    expect(judge(it, ROOT, HOME, probe)?.level).toBe('gone')
  })

  test('repeated names are looked up once', () => {
    const { probe, calls } = fake({})
    judge(item('`--one` `parseThing()` `parseThing`'), ROOT, HOME, probe)
    expect(calls.code[0]).toEqual(['--one', 'parseThing'])
  })
})

/**
 * Naming where instructions or settings can live is not a claim that a file
 * lives there, so Claude Code's own configuration locations are never judged.
 */
describe('well-known configuration locations', () => {
  const user = (text: string) => item(text, { origin: 'user', path: `${HOME}/.claude/rules/x.md` })

  test('every spelling of ~/.claude/CLAUDE.md, missing, gives no verdict', () => {
    const { probe } = fake({})
    expect(judge(item('`~/.claude/CLAUDE.md`'), ROOT, HOME, probe)).toBeNull()
    expect(judge(item(`\`${HOME}/.claude/CLAUDE.md\``), ROOT, HOME, probe)).toBeNull()
    expect(judge(user('`~/.claude/CLAUDE.md`'), ROOT, HOME, probe)).toBeNull()
    expect(judge(user(`\`${HOME}/.claude/CLAUDE.md\``), ROOT, HOME, probe)).toBeNull()
  })

  test('every spelling of CLAUDE.local.md, missing, gives no verdict', () => {
    const { probe } = fake({})
    expect(judge(item('`CLAUDE.local.md`'), ROOT, HOME, probe)).toBeNull()
    expect(judge(item('`./CLAUDE.local.md`'), ROOT, HOME, probe)).toBeNull()
    expect(judge(item(`\`${ROOT}/CLAUDE.local.md\``), ROOT, HOME, probe)).toBeNull()
  })

  test('a directory entry exempts the directory, in either spelling, but not the files below it', () => {
    const { probe } = fake({})
    expect(judge(item('`~/.claude/rules/` and `.claude/rules`'), ROOT, HOME, probe)).toBeNull()
    expect(judge(item('`~/.claude/rules/foo.md`'), ROOT, HOME, probe)).toEqual({
      level: 'gone',
      evidence: 'names `~/.claude/rules/foo.md`, which no longer exists',
    })
  })

  test('a managed policy file, missing, gives no verdict', () => {
    const { probe } = fake({})
    expect(judge(item('`/etc/claude-code/managed-settings.json`'), ROOT, HOME, probe)).toBeNull()
    expect(judge(user('`/etc/claude-code/managed-settings.json`'), ROOT, HOME, probe)).toBeNull()
  })

  /** `rules/` for both rules directories. */
  test('bare rules/ and .claude/ spellings, missing, give no verdict', () => {
    const { probe } = fake({})
    expect(judge(item('`rules/` `.claude/rules/` `.claude/settings.json`'), ROOT, HOME, probe)).toBeNull()
  })

  /** These names are common outside Claude Code; the tracked-paths rule keeps them quiet when they exist. */
  test('bare plugins/, projects/, CLAUDE.md and settings.json, missing and untracked, are gone', () => {
    for (const name of ['plugins/', 'projects/', 'CLAUDE.md', 'settings.json', 'settings.local.json']) {
      const { probe } = fake({})
      expect(judge(item(`see \`${name}\``), ROOT, HOME, probe)?.evidence).toBe(`names \`${name}\`, which no longer exists`)
    }
  })

  test('a shorthand exempts whole trailing segments only, and never an anchored name', () => {
    const { probe } = fake({})
    expect(judge(item('see `les/`'), ROOT, HOME, probe)?.evidence).toBe('names `les/`, which no longer exists')
    expect(judge(item('see `claude/rules/`'), ROOT, HOME, probe)?.evidence).toBe('names `claude/rules/`, which no longer exists')
    expect(judge(item('see `rules/x.md`'), ROOT, HOME, probe)?.evidence).toBe('names `rules/x.md`, which no longer exists')
    expect(judge(item('see `./rules/`'), ROOT, HOME, probe)?.evidence).toBe('names `./rules/`, which no longer exists')
  })

  test('a well-known location does not hide another gone name in the same item', () => {
    const { probe } = fake({})
    expect(judge(item('`.mcp.json` and `src/gone.ts`'), ROOT, HOME, probe)?.evidence).toBe('names `src/gone.ts`, which no longer exists')
  })
})
