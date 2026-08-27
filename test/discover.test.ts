import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, loadExcludes, subdirCandidates } from '../src/discover'

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-d-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), 'see @docs/extra.md\n')
  writeFileSync(join(repo, 'docs', 'extra.md'), '# Extra\n')
  writeFileSync(join(repo, 'docs', 'CLAUDE.md'), '# Docs\n')
  writeFileSync(join(repo, '.claude', 'rules', 'style.md'), '# Style\n')
  writeFileSync(join(repo, 'node_modules', 'pkg', 'CLAUDE.md'), '# Vendor\n')
  const home = join(dir, 'home', '.claude')
  mkdirSync(home, { recursive: true })
  return { repo, home }
}

test('merges excludes across settings layers', () => {
  const { repo, home } = project()
  mkdirSync(join(home), { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/a.md'] }))
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/b.md'] }))
  const got = loadExcludes(repo, home)
  expect(got).toContain('**/a.md')
  expect(got).toContain('**/b.md')
})

test('the assembled set includes the project file and the rule', () => {
  const { repo, home } = project()
  const { candidates } = discover(repo, home)
  const paths = candidates.map((c) => c.path)
  expect(paths).toContain(join(repo, 'CLAUDE.md'))
  expect(paths).toContain(join(repo, '.claude', 'rules', 'style.md'))
})

test('a subdirectory file is on-demand rather than launch', () => {
  const { repo, home } = project()
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'docs', 'CLAUDE.md'))?.label).toBe('on-demand')
})

test('dependency directories are skipped during the subdirectory walk', () => {
  const { repo, home } = project()
  const paths = discover(repo, home).candidates.map((c) => c.path)
  expect(paths).not.toContain(join(repo, 'node_modules', 'pkg', 'CLAUDE.md'))
})

test('an imported file becomes a launch candidate', () => {
  const { repo, home } = project()
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'docs', 'extra.md'))?.label).toBe('launch')
})

test('an excluded candidate is relabelled rather than dropped', () => {
  const { repo, home } = project()
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/rules/style.md'] }))
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, '.claude', 'rules', 'style.md'))?.label).toBe('excluded')
})

test('the root is the git root', () => {
  const { repo, home } = project()
  expect(discover(repo, home).root).toBe(repo)
})

test('the subdirectory walk is rooted at cwd, not the git root (monorepo)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-mono-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const pkgA = join(repo, 'packages', 'a')
  const pkgB = join(repo, 'packages', 'b')
  mkdirSync(join(pkgA, 'sub'), { recursive: true })
  mkdirSync(pkgB, { recursive: true })
  writeFileSync(join(pkgA, 'sub', 'CLAUDE.md'), '# Sub\n')
  writeFileSync(join(pkgB, 'CLAUDE.md'), '# Sibling\n')
  const home = join(dir, 'home', '.claude')
  mkdirSync(home, { recursive: true })

  const { candidates } = discover(pkgA, home)
  const byPath = new Map(candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(pkgA, 'sub', 'CLAUDE.md'))?.label).toBe('on-demand')
  expect(byPath.has(join(pkgB, 'CLAUDE.md'))).toBe(false)
})

test('excluding the importing file also excludes what only it imports', () => {
  const { repo, home } = project()
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify({ claudeMdExcludes: [join(repo, 'CLAUDE.md')] }),
  )
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'CLAUDE.md'))?.label).toBe('excluded')
  expect(byPath.has(join(repo, 'docs', 'extra.md'))).toBe(false)
})

test('a file imported by a second, non-excluded parent still surfaces', () => {
  const { repo, home } = project()
  writeFileSync(join(repo, '.claude', 'rules', 'other.md'), 'see @../../docs/extra.md\n')
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify({ claudeMdExcludes: [join(repo, 'CLAUDE.md')] }),
  )
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'CLAUDE.md'))?.label).toBe('excluded')
  expect(byPath.get(join(repo, 'docs', 'extra.md'))?.label).toBe('launch')
})

test('an oversized rules file surfaces in skipped, not silently dropped', () => {
  const { repo, home } = project()
  const big = join(repo, '.claude', 'rules', 'big.md')
  writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61))
  const { skipped, candidates } = discover(repo, home)
  expect(skipped).toContainEqual({ path: big, reason: 'too-large' })
  expect(candidates.map((c) => c.path)).not.toContain(big)
})

test('a CLAUDE.md importing a missing file surfaces the target in skipped', () => {
  const { repo, home } = project()
  writeFileSync(join(repo, 'CLAUDE.md'), 'see @docs/extra.md and @ghost.md\n')
  const { skipped } = discover(repo, home)
  expect(skipped).toContainEqual({ path: join(repo, 'ghost.md'), reason: 'missing-target' })
})

test('a symlink cycle in the subdirectory walk does not produce duplicates or hang', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-cycle-'))
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'CLAUDE.md'), '# Sub\n')
  symlinkSync(dir, join(dir, 'loop'))

  const got = subdirCandidates(dir)
  const paths = got.map((c) => c.path)
  const uniquePaths = new Set(paths)
  expect(uniquePaths.size).toBe(1)
  expect(paths.length).toBe(1)
})

test('the subdirectory walk stops at a bounded depth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-depth-'))
  const names = Array.from({ length: 9 }, (_, i) => `d${i + 1}`)
  const shallow = join(dir, ...names.slice(0, 8))
  const deep = join(dir, ...names)
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(shallow, 'CLAUDE.md'), '# Shallow\n')
  writeFileSync(join(deep, 'CLAUDE.md'), '# Deep\n')

  const paths = subdirCandidates(dir).map((c) => c.path)
  expect(paths).toContain(join(shallow, 'CLAUDE.md'))
  expect(paths).not.toContain(join(deep, 'CLAUDE.md'))
})
