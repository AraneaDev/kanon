import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { discover, loadExcludes, subdirCandidates } from '../src/discover'
import { tmp } from './tmp'

function project() {
  const dir = tmp('kanon-d-')
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
  const dir = tmp('kanon-mono-')
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

test('a CLAUDE.md importing a missing file surfaces the target in skipped, naming the importer', () => {
  const { repo, home } = project()
  writeFileSync(join(repo, 'CLAUDE.md'), 'see @docs/extra.md and @ghost.md\n')
  const { skipped } = discover(repo, home)
  expect(skipped).toContainEqual({
    path: join(repo, 'ghost.md'),
    reason: 'missing-target',
    importer: join(repo, 'CLAUDE.md'),
  })
})

test('a symlink cycle in the subdirectory walk does not produce duplicates or hang', () => {
  const dir = tmp('kanon-cycle-')
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
  const dir = tmp('kanon-depth-')
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

/**
 * The subdirectory walk starts at whatever cwd it is handed, which is
 * Claude Code's working directory rather than anything Kanon picked. A cwd
 * that has been removed, or that is not a directory at all, has to cost the
 * report nothing: discovery is layer two, and layer two failing must never
 * take the observed loads down with it.
 */
test('a cwd that does not exist yields no subdirectory candidates rather than throwing', () => {
  expect(subdirCandidates(join(tmp('kanon-d-'), 'never-created'))).toEqual([])
})

test('a cwd that is a file yields no subdirectory candidates rather than throwing', () => {
  const dir = tmp('kanon-d-')
  const file = join(dir, 'a-file')
  writeFileSync(file, 'x')
  expect(subdirCandidates(file)).toEqual([])
})

test('a dangling symlink under cwd is stepped over during the subdirectory walk', () => {
  const dir = tmp('kanon-d-')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'CLAUDE.md'), '# Sub\n')
  symlinkSync(join(dir, 'never-existed'), join(dir, 'dangling'))

  expect(subdirCandidates(dir).map((c) => c.path)).toEqual([join(dir, 'sub', 'CLAUDE.md')])
})

/**
 * CLAUDE.local.md is discovered on demand in a subdirectory too, not just
 * CLAUDE.md. It is classified `local` rather than `project`, so leaving it
 * out of the walk would make it disappear from the quiet section entirely.
 */
test('a subdirectory CLAUDE.local.md is an on-demand candidate alongside CLAUDE.md', () => {
  const dir = tmp('kanon-d-')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'CLAUDE.local.md'), '# Local\n')

  const byPath = new Map(subdirCandidates(dir).map((c) => [c.path, c]))
  expect(byPath.get(join(dir, 'sub', 'CLAUDE.local.md'))?.label).toBe('on-demand')
})

/** cwd's own CLAUDE.md belongs to the ancestor walk; the subdirectory walk must not claim it too. */
test('the subdirectory walk excludes cwd own CLAUDE.md', () => {
  const dir = tmp('kanon-d-')
  writeFileSync(join(dir, 'CLAUDE.md'), '# Here\n')
  expect(subdirCandidates(dir)).toEqual([])
})

/**
 * The audit sweep. subdirCandidates skips dependency and dot directories on
 * the stated grounds that a load observed inside one is still classified and
 * reported, so skipping costs no visibility. That justification collapses
 * when there is no session to observe anything, which is exactly the case
 * `kanon audit` runs in, so it is the one caller that opts back in.
 */
test('the audit sweep finds a dependency-shipped CLAUDE.md that the default walk skips', () => {
  const dir = tmp('kanon-audit-')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'CLAUDE.md'), '# from a dependency\n')
  writeFileSync(join(dir, 'src', 'CLAUDE.md'), '# ours\n')

  const dep = join(dir, 'node_modules', 'pkg', 'CLAUDE.md')
  expect(subdirCandidates(dir).map((c) => c.path)).not.toContain(dep)
  expect(subdirCandidates(dir, true).map((c) => c.path)).toContain(dep)
  expect(subdirCandidates(dir, true).map((c) => c.path)).toContain(join(dir, 'src', 'CLAUDE.md'))
})

/**
 * .git holds no instruction file worth reporting and is large, so the sweep
 * never enters it however wide it is asked to go.
 */
test('the audit sweep never enters .git', () => {
  const dir = tmp('kanon-audit-git-')
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(dir, '.git', 'hooks', 'CLAUDE.md'), '# not an instruction file\n')
  expect(subdirCandidates(dir, true).map((c) => c.path)).not.toContain(join(dir, '.git', 'hooks', 'CLAUDE.md'))
})

/**
 * Other dot-directories are in scope for an audit: one can hold a CLAUDE.md
 * that a session would load on demand.
 */
test('the audit sweep enters dot-directories other than .git', () => {
  const dir = tmp('kanon-audit-dot-')
  mkdirSync(join(dir, '.config'), { recursive: true })
  writeFileSync(join(dir, '.config', 'CLAUDE.md'), '# hidden but real\n')
  expect(subdirCandidates(dir, true).map((c) => c.path)).toContain(join(dir, '.config', 'CLAUDE.md'))
})

/**
 * A symlink can point anywhere, so following one lets the walk leave the
 * checkout entirely and report another tree's files as though they sat here.
 * The audit sweep makes that reachable in practice: pnpm and bun fill
 * node_modules with symlinks, and the sweep is the one caller that enters it.
 * An audit describes this checkout, so a path that is not in it is not an
 * answer to the question being asked.
 */
test('the walk does not follow a symlink out of the tree', () => {
  const dir = tmp('kanon-escape-')
  const outside = join(dir, 'elsewhere')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'CLAUDE.md'), '# not part of the checkout\n')

  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  symlinkSync(outside, join(repo, 'node_modules', 'linked'))

  expect(subdirCandidates(repo, true)).toEqual([])
})

test('a symlinked subdirectory is not followed by the ordinary walk either', () => {
  const dir = tmp('kanon-escape-plain-')
  const outside = join(dir, 'elsewhere')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'CLAUDE.md'), '# not part of the checkout\n')

  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'docs'), { recursive: true })
  symlinkSync(outside, join(repo, 'linked'))

  expect(subdirCandidates(repo)).toEqual([])
})
