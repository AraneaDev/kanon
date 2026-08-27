import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, sessionRoot } from '../src/origin'

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-o-'))
  mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
  mkdirSync(join(dir, 'repo', 'src'), { recursive: true })
  mkdirSync(join(dir, 'repo', 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(dir, 'repo', 'vendor', 'thing'), { recursive: true })
  writeFileSync(join(dir, 'repo', 'CLAUDE.md'), '')
  return dir
}

test('session root is the git root containing cwd', () => {
  const dir = tree()
  expect(sessionRoot(join(dir, 'repo', 'src'))).toBe(join(dir, 'repo'))
})

test('session root falls back to cwd outside a repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-o-'))
  expect(sessionRoot(dir)).toBe(dir)
})

test('a file under the home config directory is user scope', () => {
  const home = '/home/x/.claude'
  expect(classify('/home/x/.claude/rules/style.md', '/repo', home)).toBe('user')
})

test('a file inside node_modules is foreign', () => {
  const dir = tree()
  const root = join(dir, 'repo')
  expect(classify(join(root, 'node_modules', 'pkg', 'CLAUDE.md'), root, '/home/x/.claude')).toBe('foreign')
})

test('a file inside vendor is foreign', () => {
  const dir = tree()
  const root = join(dir, 'repo')
  expect(classify(join(root, 'vendor', 'thing', 'CLAUDE.md'), root, '/home/x/.claude')).toBe('foreign')
})

test('a file outside both the root and the home config is foreign', () => {
  expect(classify('/elsewhere/CLAUDE.md', '/repo', '/home/x/.claude')).toBe('foreign')
})

test('CLAUDE.local.md inside the root is local', () => {
  expect(classify('/repo/CLAUDE.local.md', '/repo', '/home/x/.claude')).toBe('local')
})

test('an ordinary file inside the root is project', () => {
  expect(classify('/repo/CLAUDE.md', '/repo', '/home/x/.claude')).toBe('project')
})

test('foreign wins over local, so a vendored CLAUDE.local.md is foreign', () => {
  expect(classify('/repo/vendor/a/CLAUDE.local.md', '/repo', '/home/x/.claude')).toBe('foreign')
})

test('sessionRoot resolves the root through symlinks', () => {
  // macOS reaches /tmp and /var through symlinks into /private, so a session
  // started there produced a root that none of its own files appeared to sit
  // under, and every project file was classified foreign. Both sides of that
  // comparison have to be real paths.
  const dir = mkdtempSync(join(tmpdir(), 'kanon-sym-'))
  const real = join(dir, 'real')
  mkdirSync(join(real, 'repo', '.git'), { recursive: true })
  const link = join(dir, 'link')
  symlinkSync(real, link)

  const viaLink = sessionRoot(join(link, 'repo'))
  const viaReal = sessionRoot(join(real, 'repo'))
  expect(viaLink).toBe(viaReal)
  expect(viaLink).not.toContain('link')
})

test('a project file reached through a symlink is project, never foreign', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-sym-'))
  const real = join(dir, 'real')
  mkdirSync(join(real, 'repo', '.git'), { recursive: true })
  writeFileSync(join(real, 'repo', 'CLAUDE.md'), '# Project\n')
  const link = join(dir, 'link')
  symlinkSync(real, link)

  const root = sessionRoot(join(link, 'repo'))
  expect(classify(join(link, 'repo', 'CLAUDE.md'), root, '/home/x/.claude')).toBe('project')
})
