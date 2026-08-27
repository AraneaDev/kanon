import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_FILE_BYTES, prune, tooLarge } from '../src/limits'
import { tmp } from './tmp'

test('a small file is not too large', () => {
  const dir = tmp('kanon-l-')
  const f = join(dir, 'small.md')
  writeFileSync(f, 'hello')
  expect(tooLarge(f)).toBe(false)
})

test('a file over the limit is too large', () => {
  const dir = tmp('kanon-l-')
  const f = join(dir, 'big.md')
  writeFileSync(f, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  expect(tooLarge(f)).toBe(true)
})

test('a file exactly at the limit is not too large', () => {
  const dir = tmp('kanon-l-')
  const f = join(dir, 'exact.md')
  writeFileSync(f, Buffer.alloc(MAX_FILE_BYTES, 0x61))
  expect(tooLarge(f)).toBe(false)
})

test('a missing file is not too large', () => {
  expect(tooLarge('/definitely/not/here.md')).toBe(false)
})

test('prune removes files older than the cutoff', () => {
  const home = tmp('kanon-p-')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const old = join(home, 'sessions', 'old.jsonl')
  writeFileSync(old, '{}')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(old, longAgo, longAgo)
  const removed = prune(home, Date.now())
  expect(removed).toContain(old)
  expect(existsSync(old)).toBe(false)
})

test('prune keeps recent files', () => {
  const home = tmp('kanon-p-')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const fresh = join(home, 'sessions', 'fresh.jsonl')
  writeFileSync(fresh, '{}')
  prune(home, Date.now())
  expect(existsSync(fresh)).toBe(true)
})

test('prune respects a custom maxAgeDays', () => {
  const home = tmp('kanon-p-')
  mkdirSync(join(home, 'state'), { recursive: true })
  const f = join(home, 'state', 'recent.json')
  writeFileSync(f, '{}')
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  utimesSync(f, tenDaysAgo, tenDaysAgo)
  expect(prune(home, Date.now(), 90)).toEqual([])
  expect(prune(home, Date.now(), 5)).toContain(f)
})

test('prune on a missing directory returns nothing rather than throwing', () => {
  expect(prune('/definitely/not/here', Date.now())).toEqual([])
})

test('prune covers sessions, state and reports', () => {
  const home = tmp('kanon-p-')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  const paths: string[] = []
  for (const sub of ['sessions', 'state', 'reports']) {
    mkdirSync(join(home, sub), { recursive: true })
    const f = join(home, sub, 'x')
    writeFileSync(f, '{}')
    utimesSync(f, longAgo, longAgo)
    paths.push(f)
  }
  const removed = prune(home, Date.now())
  for (const p of paths) {
    expect(removed).toContain(p)
    expect(existsSync(p)).toBe(false)
  }
})

test('prune does not follow a symlinked sessions directory out of kanonHome', () => {
  const home = tmp('kanon-p-')
  const outside = tmp('kanon-outside-')
  const victim = join(outside, 'victim.jsonl')
  writeFileSync(victim, '{}')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(victim, longAgo, longAgo)
  symlinkSync(outside, join(home, 'sessions'))
  const removed = prune(home, Date.now())
  expect(removed).toEqual([])
  expect(existsSync(victim)).toBe(true)
})

test('prune does not delete through a symlinked entry pointing outside kanonHome', () => {
  const home = tmp('kanon-p-')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const outside = tmp('kanon-outside-')
  const victim = join(outside, 'victim.jsonl')
  writeFileSync(victim, '{}')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(victim, longAgo, longAgo)
  symlinkSync(victim, join(home, 'sessions', 'link.jsonl'))
  const removed = prune(home, Date.now())
  expect(removed).toEqual([])
  expect(existsSync(victim)).toBe(true)
})

test('prune leaves a stray subdirectory alone rather than recursing into it', () => {
  const home = tmp('kanon-p-')
  const nested = join(home, 'sessions', 'nested')
  mkdirSync(nested, { recursive: true })
  const f = join(nested, 'inner.jsonl')
  writeFileSync(f, '{}')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(f, longAgo, longAgo)
  utimesSync(nested, longAgo, longAgo)
  const removed = prune(home, Date.now())
  expect(removed).toEqual([])
  expect(existsSync(f)).toBe(true)
})

/**
 * prune runs on every CLI invocation, against a real home directory, before
 * anything is reported. A directory inside it that cannot be listed must
 * therefore cost it nothing at all: it moves on to the next one rather than
 * throwing out of the housekeeping pass and taking the report with it.
 *
 * Root ignores the permission bits that set this up, so the check only means
 * anything for an unprivileged user. That is what CI runs as.
 */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

test.skipIf(asRoot)('prune steps over a directory it cannot list and keeps going', () => {
  const home = tmp('kanon-p-')
  const longAgo = new Date('2020-01-01T00:00:00Z')

  const locked = join(home, 'reports')
  mkdirSync(locked, { recursive: true })
  const hidden = join(locked, 'old.txt')
  writeFileSync(hidden, 'x')
  utimesSync(hidden, longAgo, longAgo)

  const readable = join(home, 'sessions')
  mkdirSync(readable, { recursive: true })
  const old = join(readable, 'old.jsonl')
  writeFileSync(old, '{}')
  utimesSync(old, longAgo, longAgo)

  chmodSync(locked, 0o000)
  let removed: string[]
  try {
    removed = prune(home, Date.now())
  } finally {
    // Restored before asserting: a path inside an unlistable directory
    // cannot be stat'd either, so `hidden` would read as absent whether
    // prune had left it alone or deleted it.
    chmodSync(locked, 0o700)
  }

  expect(removed).toEqual([old])
  expect(existsSync(hidden)).toBe(true)
})

/** A file exactly one byte under the limit is the last one Claude Code loads. */
test('a file one byte under the limit is not too large', () => {
  const dir = tmp('kanon-l-')
  const f = join(dir, 'under.md')
  writeFileSync(f, Buffer.alloc(MAX_FILE_BYTES - 1, 0x61))
  expect(tooLarge(f)).toBe(false)
})

/** A directory is not a file over the limit; the caller's own read is what reports it. */
test('a directory is never too large', () => {
  expect(tooLarge(tmp('kanon-l-'))).toBe(false)
})

/**
 * prune is the one function that deletes, and it is pointed at a real
 * `~/.kanon`. Anything it does not recognise as one of its own three
 * directories is not its business, however old it is.
 */
test('prune never touches a directory outside sessions, state and reports', () => {
  const home = tmp('kanon-p-')
  mkdirSync(join(home, 'something-else'), { recursive: true })
  const f = join(home, 'something-else', 'old.txt')
  writeFileSync(f, 'x')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(f, longAgo, longAgo)

  expect(prune(home, Date.now())).toEqual([])
  expect(existsSync(f)).toBe(true)
})

/** A file dropped straight into ~/.kanon is not in a pruned directory either. */
test('prune never touches a file sitting directly in kanonHome', () => {
  const home = tmp('kanon-p-')
  const f = join(home, 'stray.txt')
  writeFileSync(f, 'x')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(f, longAgo, longAgo)

  expect(prune(home, Date.now())).toEqual([])
  expect(existsSync(f)).toBe(true)
})
