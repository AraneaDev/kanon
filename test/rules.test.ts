import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ruleCandidates } from '../src/discover/rules'
import { MAX_FILE_BYTES } from '../src/limits'

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

test('a BOM-prefixed rule with paths frontmatter is path-scoped', () => {
  const rules = rulesDir()
  writeFileSync(join(rules, 'bom.md'), '﻿---\npaths:\n  - "src/**/*.ts"\n---\n\n# BOM\n')
  const byPath = new Map(ruleCandidates([rules]).map((c) => [c.path, c]))
  expect(byPath.get(join(rules, 'bom.md'))?.label).toBe('path-scoped')
})

test('follows a symlinked rules subdirectory', () => {
  const rules = rulesDir()
  const other = mkdtempSync(join(tmpdir(), 'kanon-shared-'))
  writeFileSync(join(other, 'shared.md'), '# Shared\n')
  symlinkSync(other, join(rules, 'shared'))
  const names = ruleCandidates([rules]).map((c) => c.path.split('/').pop())
  expect(names).toContain('shared.md')
})

test('follows a symlinked rule file', () => {
  const rules = rulesDir()
  const external = mkdtempSync(join(tmpdir(), 'kanon-external-'))
  const filePath = join(external, 'linked.md')
  writeFileSync(filePath, '---\npaths:\n  - "test/**"\n---\n\n# Linked\n')
  symlinkSync(filePath, join(rules, 'linked.md'))
  const byPath = new Map(ruleCandidates([rules]).map((c) => [c.path, c]))
  expect(byPath.get(join(rules, 'linked.md'))).toBeDefined()
  expect(byPath.get(join(rules, 'linked.md'))?.label).toBe('path-scoped')
})

test('survives a symlink cycle without hanging', () => {
  const rules = rulesDir()
  symlinkSync(rules, join(rules, 'loop'))
  const got = ruleCandidates([rules])
  // Should find exactly the 2 real files (style.md and backend/api.md), no duplicates
  const paths = got.map((c) => c.path)
  const uniquePaths = new Set(paths)
  expect(uniquePaths.size).toBe(2)
  expect(paths.length).toBe(2)
})

test('a missing rules directory yields nothing rather than throwing', () => {
  expect(ruleCandidates(['/definitely/not/here'])).toEqual([])
})

test('a rule file over 4 MiB is skipped rather than read', () => {
  const rules = rulesDir()
  const big = join(rules, 'big.md')
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  const paths = ruleCandidates([rules]).map((c) => c.path)
  expect(paths).not.toContain(big)
})

test('a rule file over 4 MiB is reported to onSkip with reason too-large', () => {
  const rules = rulesDir()
  const big = join(rules, 'big.md')
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  const skips: Array<{ path: string; reason: string }> = []
  ruleCandidates([rules], (path, reason) => skips.push({ path, reason }))
  expect(skips).toContainEqual({ path: big, reason: 'too-large' })
})

test('onSkip is optional and existing callers are unaffected', () => {
  const rules = rulesDir()
  expect(() => ruleCandidates([rules])).not.toThrow()
})
