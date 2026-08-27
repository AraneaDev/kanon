import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ruleCandidates } from '../src/discover/rules'
import { MAX_FILE_BYTES } from '../src/limits'
import { tmp } from './tmp'

function rulesDir(): string {
  const dir = tmp('kanon-r-')
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
  const other = tmp('kanon-shared-')
  writeFileSync(join(other, 'shared.md'), '# Shared\n')
  symlinkSync(other, join(rules, 'shared'))
  const names = ruleCandidates([rules]).map((c) => c.path.split('/').pop())
  expect(names).toContain('shared.md')
})

test('follows a symlinked rule file', () => {
  const rules = rulesDir()
  const external = tmp('kanon-external-')
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

/**
 * A rules root that is not a directory at all: `readdirSync` fails with
 * ENOTDIR where `statSync` succeeded, and the walk has to treat that the way
 * it treats a missing directory. Nothing in Kanon chooses these two paths --
 * they are `~/.claude/rules` and `<root>/.claude/rules`, whatever the user
 * happens to have put there.
 */
test('a rules path that is a file rather than a directory yields nothing', () => {
  const dir = tmp('kanon-r-')
  const file = join(dir, 'rules')
  writeFileSync(file, 'someone put a file here\n')
  expect(ruleCandidates([file])).toEqual([])
})

/**
 * The walk follows symlinks, so a link whose target has been deleted stats
 * as nothing at all. It is stepped over; the real rules beside it still have
 * to come back.
 */
test('a dangling symlink in a rules directory is stepped over, not fatal', () => {
  const rules = rulesDir()
  symlinkSync(join(rules, 'never-existed.md'), join(rules, 'dangling.md'))
  const paths = ruleCandidates([rules]).map((c) => c.path)
  expect(paths).toContain(join(rules, 'style.md'))
  expect(paths).toContain(join(rules, 'backend', 'api.md'))
  expect(paths).not.toContain(join(rules, 'dangling.md'))
})

/**
 * A .md entry that exists, is not a directory, is under the size limit, and
 * still cannot be opened. An unreadable rule is noted rather than silently
 * dropped, for the same reason an oversized one is: a file that vanishes
 * from every section of the report is a worse failure than one listed under
 * COULD NOT READ.
 *
 * A unix socket is what makes this portable. `chmod 000` would do it for an
 * ordinary user and do nothing at all for root, and CI runs as both.
 */
test('a .md entry that exists but cannot be read is reported unreadable, not dropped', () => {
  const rules = rulesDir()
  const sock = join(rules, 'socket.md')
  const server = Bun.listen({ unix: sock, socket: { data() {} } })
  try {
    const skips: Array<{ path: string; reason: string }> = []
    const paths = ruleCandidates([rules], (path, reason) => skips.push({ path, reason })).map((c) => c.path)
    expect(skips).toContainEqual({ path: sock, reason: 'unreadable' })
    expect(paths).not.toContain(sock)
    expect(paths).toContain(join(rules, 'style.md'))
  } finally {
    server.stop(true)
  }
})
