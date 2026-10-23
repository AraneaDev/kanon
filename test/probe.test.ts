import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitProbe, lastCommit } from '../src/probe'
import { tmp } from './tmp'

function git(root: string, args: string[], date?: string): void {
  const env = date ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : process.env
  const p = Bun.spawnSync(['git', '-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
}

function repo(): string {
  const root = tmp('kanon-probe-')
  git(root, ['init', '-q'])
  return root
}

function commit(root: string, files: Record<string, string>, date: string): void {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), body)
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'c'], date)
}

describe('gitProbe.occursInCode', () => {
  test('finds a symbol in a .ts file and ignores one only in Markdown', () => {
    const root = repo()
    commit(root, { 'a.ts': 'export function realThing() {}\n', 'n.md': 'ghostThing is documented\n' }, '2026-01-01T00:00:00Z')
    const got = gitProbe(root).occursInCode(['realThing', 'ghostThing', 'absent'])
    expect(got).toEqual(new Set(['realThing']))
  })

  test('a name occurring only inside a longer name is still found', () => {
    const root = repo()
    commit(root, { 'a.ts': 'foobar(1)\n' }, '2026-01-01T00:00:00Z')
    expect(gitProbe(root).occursInCode(['foo', 'foobar'])).toEqual(new Set(['foo', 'foobar']))
  })

  test('an empty name is never searched and never throws; an absent name stays absent', () => {
    const root = repo()
    commit(root, { 'a.ts': 'x\n' }, '2026-01-01T00:00:00Z')
    const got = gitProbe(root).occursInCode(['', 'absentName'])
    expect(got.has('absentName')).toBe(false)
    expect(got.has('')).toBe(true)
  })

  test('a name with a newline is dropped and counts as found', () => {
    const root = repo()
    commit(root, { 'a.ts': 'x\n' }, '2026-01-01T00:00:00Z')
    const got = gitProbe(root).occursInCode(['a\nb', 'absentName'])
    expect(got.has('a\nb')).toBe(true)
    expect(got.has('absentName')).toBe(false)
  })

  test('a name starting with a dash is found', () => {
    const root = repo()
    commit(root, { 'a.ts': "const flag = '--fix'\n" }, '2026-01-01T00:00:00Z')
    expect(gitProbe(root).occursInCode(['--fix'])).toEqual(new Set(['--fix']))
  })

  test('a name present only in a tracked binary file is not found', () => {
    const root = repo()
    writeFileSync(join(root, 'blob.bin'), Buffer.concat([Buffer.from('binaryOnlyName'), Buffer.from([0, 1, 2])]))
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'c'], '2026-01-01T00:00:00Z')
    expect(gitProbe(root).occursInCode(['binaryOnlyName'])).toEqual(new Set())
  })

  test('no match at all is an empty set', () => {
    const root = repo()
    commit(root, { 'a.ts': 'x\n' }, '2026-01-01T00:00:00Z')
    expect(gitProbe(root).occursInCode(['nothingHere'])).toEqual(new Set())
  })

  test('outside a git repo every name counts as found', () => {
    const dir = tmp('kanon-nogit-')
    expect(gitProbe(dir).occursInCode(['a', 'b'])).toEqual(new Set(['a', 'b']))
  })
})

describe('gitProbe.changedSince', () => {
  test('returns a file committed after the date and not one committed before', () => {
    const root = repo()
    commit(root, { 'old.ts': '1\n' }, '2026-01-01T00:00:00Z')
    commit(root, { 'new.ts': '1\n' }, '2026-03-01T00:00:00Z')
    const got = gitProbe(root).changedSince(['old.ts', 'new.ts'], new Date('2026-02-01T00:00:00Z'))
    expect(got).toEqual(['new.ts'])
  })

  test('a file changed twice is reported once', () => {
    const root = repo()
    commit(root, { 'a.ts': '1\n' }, '2026-03-01T00:00:00Z')
    commit(root, { 'a.ts': '2\n' }, '2026-04-01T00:00:00Z')
    expect(gitProbe(root).changedSince(['a.ts'], new Date('2026-02-01T00:00:00Z'))).toEqual(['a.ts'])
  })

  test('empty path list and non-repo both give []', () => {
    const root = repo()
    expect(gitProbe(root).changedSince([], new Date(0))).toEqual([])
    expect(gitProbe(tmp('kanon-nogit-')).changedSince(['a.ts'], new Date(0))).toEqual([])
  })
})

describe('gitProbe.scripts', () => {
  test('reads the script names from package.json', () => {
    const root = tmp('kanon-pkg-')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'x', test: 'y' } }))
    expect(gitProbe(root).scripts()).toEqual(new Set(['build', 'test']))
  })

  test('missing or malformed package.json is null', () => {
    const root = tmp('kanon-pkg-')
    expect(gitProbe(root).scripts()).toBeNull()
    writeFileSync(join(root, 'package.json'), '{nope')
    expect(gitProbe(root).scripts()).toBeNull()
  })
})

describe('gitProbe.exists', () => {
  test('present and absent paths', () => {
    const root = tmp('kanon-ex-')
    writeFileSync(join(root, 'f'), '')
    const p = gitProbe(root)
    expect(p.exists(join(root, 'f'))).toBe(true)
    expect(p.exists(join(root, 'nope'))).toBe(false)
    expect(p.exists(join(root, 'f', 'child'))).toBe(false) // ENOTDIR
  })

  test('a dangling symlink counts as absent, a live one as present', () => {
    const root = tmp('kanon-ex-')
    writeFileSync(join(root, 'f'), '')
    symlinkSync(join(root, 'f'), join(root, 'live'))
    symlinkSync(join(root, 'missing'), join(root, 'dangling'))
    const p = gitProbe(root)
    expect(p.exists(join(root, 'live'))).toBe(true)
    expect(p.exists(join(root, 'dangling'))).toBe(false)
  })

  test.skipIf(process.getuid?.() === 0)('a path under an unreadable directory is reported present', () => {
    const root = tmp('kanon-ex-')
    const locked = join(root, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'inner'), '')
    chmodSync(locked, 0o000)
    try {
      expect(gitProbe(root).exists(join(locked, 'inner'))).toBe(true)
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})

describe('lastCommit', () => {
  test('the date of the last commit touching a path', () => {
    const root = repo()
    commit(root, { 'a.ts': '1\n' }, '2026-03-01T00:00:00Z')
    expect(lastCommit(root, 'a.ts')?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  test('an uncommitted file and a non-repo are null', () => {
    const root = repo()
    commit(root, { 'a.ts': '1\n' }, '2026-03-01T00:00:00Z')
    writeFileSync(join(root, 'new.ts'), 'x')
    expect(lastCommit(root, 'new.ts')).toBeNull()
    expect(lastCommit(tmp('kanon-nogit-'), 'a.ts')).toBeNull()
  })
})

describe('gitProbe.trackedBasenames', () => {
  test('returns the basenames of tracked files only', () => {
    const root = repo()
    commit(root, { 'src/normalise.ts': 'x', 'README.md': 'y', 'deep/a/b/c.json': '{}' }, '2026-01-01T00:00:00Z')
    writeFileSync(join(root, 'untracked.ts'), 'z')
    expect(gitProbe(root).trackedBasenames()).toEqual(new Set(['normalise.ts', 'README.md', 'c.json']))
  })

  /** One git spawn per probe: the second call answers from the cache even with git gone. */
  test('asks git once across two calls', () => {
    const root = repo()
    commit(root, { 'src/a.ts': 'x' }, '2026-01-01T00:00:00Z')
    const probe = gitProbe(root)
    const first = probe.trackedBasenames()
    rmSync(join(root, '.git'), { recursive: true, force: true })
    expect(probe.trackedBasenames()).toBe(first)
    expect(first).toEqual(new Set(['a.ts']))
  })

  test('is null outside a repository', () => {
    expect(gitProbe(tmp('kanon-nogit-')).trackedBasenames()).toBeNull()
  })
})
