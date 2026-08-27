import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseImports, resolveImports } from '../src/discover/imports'
import { MAX_FILE_BYTES } from '../src/limits'

test('finds a bare import', () => {
  expect(parseImports('See @docs/git.md for detail')).toEqual(['docs/git.md'])
})

test('ignores an import inside a code span', () => {
  expect(parseImports('Write `@README` to mention it')).toEqual([])
})

test('ignores an import inside a fenced block', () => {
  const text = '```\n@docs/nope.md\n```\n@docs/yes.md\n'
  expect(parseImports(text)).toEqual(['docs/yes.md'])
})

test('finds a home-relative import', () => {
  expect(parseImports('- @~/.claude/mine.md')).toEqual(['~/.claude/mine.md'])
})

test('resolves relative to the importing file, not the cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'CLAUDE.md'), 'see @child.md\n')
  writeFileSync(join(dir, 'child.md'), 'leaf\n')
  const got = resolveImports([join(dir, 'CLAUDE.md')])
  expect(got.get(join(dir, 'child.md'))).toBe(join(dir, 'CLAUDE.md'))
})

test('follows a chain to depth four', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@c.md\n')
  writeFileSync(join(dir, 'c.md'), '@d.md\n')
  writeFileSync(join(dir, 'd.md'), '@e.md\n')
  writeFileSync(join(dir, 'e.md'), '@f.md\n')
  writeFileSync(join(dir, 'f.md'), 'leaf\n')
  const got = resolveImports([join(dir, 'a.md')])
  const keys = new Set(got.keys())
  expect(keys.has(join(dir, 'b.md'))).toBe(true)
  expect(keys.has(join(dir, 'c.md'))).toBe(true)
  expect(keys.has(join(dir, 'd.md'))).toBe(true)
  expect(keys.has(join(dir, 'e.md'))).toBe(true)
  expect(keys.has(join(dir, 'f.md'))).toBe(false)
})

test('stops after four hops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@c.md\n')
  writeFileSync(join(dir, 'c.md'), '@d.md\n')
  writeFileSync(join(dir, 'd.md'), '@e.md\n')
  writeFileSync(join(dir, 'e.md'), '@f.md\n')
  writeFileSync(join(dir, 'f.md'), 'too far\n')
  const got = resolveImports([join(dir, 'a.md')])
  const keys = new Set(got.keys())
  expect(keys.has(join(dir, 'b.md'))).toBe(true)
  expect(keys.has(join(dir, 'c.md'))).toBe(true)
  expect(keys.has(join(dir, 'd.md'))).toBe(true)
  expect(keys.has(join(dir, 'e.md'))).toBe(true)
  expect(keys.has(join(dir, 'f.md'))).toBe(false)
})

test('survives an import cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@a.md\n')
  const got = resolveImports([join(dir, 'a.md')])
  expect(got.has(join(dir, 'b.md'))).toBe(true)
})

test('seed file never appears as a key even in a cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@a.md\n')
  const got = resolveImports([join(dir, 'a.md')])
  expect(got.has(join(dir, 'a.md'))).toBe(false)
  expect(got.has(join(dir, 'b.md'))).toBe(true)
})

test('ignores an import target that does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@ghost.md\n')
  expect(resolveImports([join(dir, 'a.md')]).size).toBe(0)
})

test('strips trailing period from import', () => {
  expect(parseImports('see @docs/a.md.')).toEqual(['docs/a.md'])
})

test('strips trailing paren from import', () => {
  expect(parseImports('(see @docs/c.md)')).toEqual(['docs/c.md'])
})

test('matches import with opening bracket', () => {
  expect(parseImports('[@docs/d.md]')).toEqual(['docs/d.md'])
})

test('does not match email-like pattern', () => {
  expect(parseImports('contact foo@bar.com')).toEqual([])
})

test('handles unterminated code fence', () => {
  const text = '```\n@docs/nope.md\nmore content with @docs/yes.md\n'
  expect(parseImports(text)).toEqual([])
})

test('an importer over 4 MiB is skipped rather than read for imports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  const big = join(dir, 'big.md')
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  writeFileSync(big, '\n@child.md\n', { flag: 'a' })
  writeFileSync(join(dir, 'child.md'), 'leaf\n')
  const got = resolveImports([big])
  expect(got.size).toBe(0)
})

test('an importer over 4 MiB is reported to onSkip with reason too-large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  const big = join(dir, 'big.md')
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  const skips: Array<{ path: string; reason: string }> = []
  resolveImports([big], 4, (path, reason) => skips.push({ path, reason }))
  expect(skips).toContainEqual({ path: big, reason: 'too-large' })
})

test('an @import whose target does not exist is reported to onSkip with reason missing-target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  const claude = join(dir, 'CLAUDE.md')
  writeFileSync(claude, 'see @ghost.md\n')
  const skips: Array<{ path: string; reason: string }> = []
  const got = resolveImports([claude], 4, (path, reason) => skips.push({ path, reason }))
  expect(got.size).toBe(0)
  expect(skips).toContainEqual({ path: join(dir, 'ghost.md'), reason: 'missing-target' })
})

test('an @import whose target does not exist reports the importer to onSkip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  const claude = join(dir, 'CLAUDE.md')
  writeFileSync(claude, 'see @ghost.md\n')
  const skips: Array<{ path: string; reason: string; importer?: string }> = []
  resolveImports([claude], 4, (path, reason, importer) => skips.push({ path, reason, importer }))
  expect(skips).toContainEqual({ path: join(dir, 'ghost.md'), reason: 'missing-target', importer: claude })
})

test('onSkip is optional and existing callers are unaffected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), 'see @ghost.md\n')
  expect(() => resolveImports([join(dir, 'a.md')])).not.toThrow()
})

test('resolves tilde imports to home directory', () => {
  // Bun caches os.homedir(), so redirecting HOME at runtime does not work.
  // The target therefore has to live under the real home directory. It goes
  // in a temp directory there rather than under ~/.claude, which is the one
  // place Kanon promises never to write, and it is removed afterwards.
  const homeTmp = mkdtempSync(join(homedir(), '.kanon-test-'))
  const target = join(homeTmp, 'imported.md')
  writeFileSync(target, 'home test file\n')

  const sourceDir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  const sourceFile = join(sourceDir, 'source.md')
  writeFileSync(sourceFile, `@~/${basename(homeTmp)}/imported.md\n`)

  try {
    const got = resolveImports([sourceFile])
    expect(got.has(target)).toBe(true)
    expect(got.get(target)).toBe(sourceFile)
  } finally {
    rmSync(homeTmp, { recursive: true, force: true })
  }
})
