import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseImports, resolveImports } from '../src/discover/imports'

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
  writeFileSync(join(dir, 'e.md'), 'leaf\n')
  const got = resolveImports([join(dir, 'a.md')])
  expect(got.has(join(dir, 'd.md'))).toBe(true)
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
  expect(got.has(join(dir, 'f.md'))).toBe(false)
})

test('survives an import cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@a.md\n')
  const got = resolveImports([join(dir, 'a.md')])
  expect(got.has(join(dir, 'b.md'))).toBe(true)
})

test('ignores an import target that does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@ghost.md\n')
  expect(resolveImports([join(dir, 'a.md')]).size).toBe(0)
})
