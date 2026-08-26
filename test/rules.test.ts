import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ruleCandidates } from '../src/discover/rules'

function rulesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-r-'))
  const rules = join(dir, '.claude', 'rules')
  mkdirSync(join(rules, 'backend'), { recursive: true })
  writeFileSync(join(rules, 'style.md'), '# Style\n\nUse two spaces.\n')
  writeFileSync(join(rules, 'backend', 'api.md'), '---\npaths:\n  - "src/api/**/*.ts"\n---\n\n# API\n')
  writeFileSync(join(rules, 'notes.txt'), 'not markdown')
  return rules
}

test('discovers markdown rules recursively', () => {
  const rules = rulesDir()
  const paths = ruleCandidates([rules]).map((c) => c.path)
  expect(paths).toContain(join(rules, 'style.md'))
  expect(paths).toContain(join(rules, 'backend', 'api.md'))
})

test('ignores files that are not markdown', () => {
  const rules = rulesDir()
  const paths = ruleCandidates([rules]).map((c) => c.path)
  expect(paths).not.toContain(join(rules, 'notes.txt'))
})

test('a rule without paths frontmatter is launch', () => {
  const rules = rulesDir()
  const byPath = new Map(ruleCandidates([rules]).map((c) => [c.path, c]))
  expect(byPath.get(join(rules, 'style.md'))?.label).toBe('launch')
})

test('a rule with paths frontmatter is path-scoped', () => {
  const rules = rulesDir()
  const byPath = new Map(ruleCandidates([rules]).map((c) => [c.path, c]))
  expect(byPath.get(join(rules, 'backend', 'api.md'))?.label).toBe('path-scoped')
})

test('follows a symlinked rules subdirectory', () => {
  const rules = rulesDir()
  const other = mkdtempSync(join(tmpdir(), 'kanon-shared-'))
  writeFileSync(join(other, 'shared.md'), '# Shared\n')
  symlinkSync(other, join(rules, 'shared'))
  const names = ruleCandidates([rules]).map((c) => c.path.split('/').pop())
  expect(names).toContain('shared.md')
})

test('survives a symlink cycle without hanging', () => {
  const rules = rulesDir()
  symlinkSync(rules, join(rules, 'loop'))
  const got = ruleCandidates([rules])
  expect(got.length).toBeGreaterThan(0)
})

test('a missing rules directory yields nothing rather than throwing', () => {
  expect(ruleCandidates(['/definitely/not/here'])).toEqual([])
})
