import { expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, hasDependencySegment, managedPath, sessionRoot } from '../src/origin'
import { tmp } from './tmp'

function tree(): string {
  const dir = tmp('kanon-o-')
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
  const dir = tmp('kanon-o-')
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
  const dir = tmp('kanon-sym-')
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
  const dir = tmp('kanon-sym-')
  const real = join(dir, 'real')
  mkdirSync(join(real, 'repo', '.git'), { recursive: true })
  writeFileSync(join(real, 'repo', 'CLAUDE.md'), '# Project\n')
  const link = join(dir, 'link')
  symlinkSync(real, link)

  const root = sessionRoot(join(link, 'repo'))
  expect(classify(join(link, 'repo', 'CLAUDE.md'), root, '/home/x/.claude')).toBe('project')
})

/**
 * `sessionRoot` is handed a cwd it did not choose, and a cwd that no longer
 * exists must not take the CLI down with it: realpath failing falls back to
 * the path as given, and the ancestor walk carries on from there.
 */
test('sessionRoot falls back to the path as given when it cannot be resolved', () => {
  const gone = join(tmp('kanon-o-'), 'never-created')
  expect(sessionRoot(gone)).toBe(gone)
})

test('the managed policy path is the platform one', () => {
  expect(managedPath('linux')).toBe('/etc/claude-code/CLAUDE.md')
  expect(managedPath('darwin')).toBe('/Library/Application Support/ClaudeCode/CLAUDE.md')
  expect(managedPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\CLAUDE.md')
})

/**
 * A platform Kanon has no entry for gets the Linux path rather than
 * `undefined`, which `classify` would otherwise compare against every loaded
 * path and call a match for nothing at all.
 */
test('an unknown platform falls back to the linux managed path rather than undefined', () => {
  expect(managedPath('freebsd')).toBe(managedPath('linux'))
})

test('a dependency directory below the root is a dependency segment', () => {
  expect(hasDependencySegment('/repo/node_modules/pkg/CLAUDE.md', '/repo')).toBe(true)
})

/**
 * Only the part of the path below the root is inspected, and this is why. A
 * project checked out at /srv/vendor/app is not its own dependency: matching
 * on the whole path would call every file in it FOREIGN, which is the worst
 * output this tool has.
 */
test('a dependency-named directory above the root does not make the project foreign', () => {
  expect(hasDependencySegment('/srv/vendor/app/CLAUDE.md', '/srv/vendor/app')).toBe(false)
  expect(classify('/srv/vendor/app/CLAUDE.md', '/srv/vendor/app', '/home/x/.claude')).toBe('project')
})

/** A path outside the root entirely is inspected whole, since none of it is the project's. */
test('a dependency segment is still recognised in a path outside the root', () => {
  expect(hasDependencySegment('/elsewhere/vendor/p/CLAUDE.md', '/repo')).toBe(true)
})

/**
 * A file can be reported loaded and then removed before the report is built.
 * Classifying the path as given is the honest answer there; throwing would
 * lose every other row in the report along with it.
 */
test('a loaded path that no longer exists is still classified rather than throwing', () => {
  const dir = tmp('kanon-o-')
  expect(classify(join(dir, 'gone', 'CLAUDE.md'), dir, '/home/x/.claude')).toBe('project')
})
