import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, loadExcludes } from '../src/discover'

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
