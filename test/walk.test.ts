import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkCandidates } from '../src/discover/walk'

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-w-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'pkg', 'app'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), '')
  writeFileSync(join(repo, 'CLAUDE.local.md'), '')
  writeFileSync(join(repo, '.claude', 'CLAUDE.md'), '')
  writeFileSync(join(repo, 'pkg', 'CLAUDE.md'), '')
  const home = join(dir, 'home', '.claude')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'CLAUDE.md'), '')
  return { dir, repo, home, cwd: join(repo, 'pkg', 'app') }
}

test('collects CLAUDE.md from every ancestor of cwd as launch', () => {
  const { repo, home, cwd } = tree()
  const got = walkCandidates(cwd, home)
  const byPath = new Map(got.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'CLAUDE.md'))?.label).toBe('launch')
  expect(byPath.get(join(repo, 'pkg', 'CLAUDE.md'))?.label).toBe('launch')
})

test('collects CLAUDE.local.md alongside CLAUDE.md', () => {
  const { repo, home, cwd } = tree()
  const paths = walkCandidates(cwd, home).map((c) => c.path)
  expect(paths).toContain(join(repo, 'CLAUDE.local.md'))
})

test('collects the dot-claude project file', () => {
  const { repo, home, cwd } = tree()
  const paths = walkCandidates(cwd, home).map((c) => c.path)
  expect(paths).toContain(join(repo, '.claude', 'CLAUDE.md'))
})

test('collects the user scope file as launch', () => {
  const { home, cwd } = tree()
  const byPath = new Map(walkCandidates(cwd, home).map((c) => [c.path, c]))
  expect(byPath.get(join(home, 'CLAUDE.md'))?.label).toBe('launch')
})

test('every candidate names the rule that produced it', () => {
  const { home, cwd } = tree()
  const validRules = new Set(['managed-policy', 'user-scope', 'ancestor-walk'])
  for (const c of walkCandidates(cwd, home)) expect(validRules.has(c.rule)).toBe(true)
})

test('returns no duplicate paths', () => {
  const { home, cwd } = tree()
  const paths = walkCandidates(cwd, home).map((c) => c.path)
  expect(paths.length).toBe(new Set(paths).size)
})

test('returns candidates in order: broadest to narrowest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-w-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'mid'), { recursive: true })
  mkdirSync(join(repo, 'mid', 'deep'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), '')
  writeFileSync(join(repo, 'mid', 'CLAUDE.md'), '')
  const home = join(dir, 'home', '.claude')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'CLAUDE.md'), '')

  const cwd = join(repo, 'mid', 'deep')
  const candidates = walkCandidates(cwd, home)
  const paths = candidates.map((c) => c.path)

  const userScopeIdx = paths.indexOf(join(home, 'CLAUDE.md'))
  const repoRootIdx = paths.indexOf(join(repo, 'CLAUDE.md'))
  const midIdx = paths.indexOf(join(repo, 'mid', 'CLAUDE.md'))

  expect(userScopeIdx).toBeLessThan(repoRootIdx)
  expect(repoRootIdx).toBeLessThan(midIdx)
})

test('deduplicates when cwd is under home, keeping user-scope rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-w-'))
  const home = join(dir, 'home', '.claude')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'CLAUDE.md'), '')

  const projectDir = join(dir, 'home', 'code', 'project')
  mkdirSync(projectDir, { recursive: true })

  const candidates = walkCandidates(projectDir, home)
  const paths = candidates.map((c) => c.path)
  const userScopeFile = join(home, 'CLAUDE.md')

  // Should appear exactly once
  expect(paths.filter((p) => p === userScopeFile).length).toBe(1)

  // Should have user-scope rule, not ancestor-walk
  const userScopeCandidate = candidates.find((c) => c.path === userScopeFile)
  expect(userScopeCandidate?.rule).toBe('user-scope')
})
