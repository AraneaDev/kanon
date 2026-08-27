import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FILE_BYTES, prune, tooLarge } from '../src/limits'

test('a small file is not too large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-l-'))
  const f = join(dir, 'small.md')
  writeFileSync(f, 'hello')
  expect(tooLarge(f)).toBe(false)
})

test('a file over the limit is too large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-l-'))
  const f = join(dir, 'big.md')
  writeFileSync(f, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  expect(tooLarge(f)).toBe(true)
})

test('a file exactly at the limit is not too large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-l-'))
  const f = join(dir, 'exact.md')
  writeFileSync(f, Buffer.alloc(MAX_FILE_BYTES, 0x61))
  expect(tooLarge(f)).toBe(false)
})

test('a missing file is not too large', () => {
  expect(tooLarge('/definitely/not/here.md')).toBe(false)
})

test('prune removes files older than the cutoff', () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
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
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const fresh = join(home, 'sessions', 'fresh.jsonl')
  writeFileSync(fresh, '{}')
  prune(home, Date.now())
  expect(existsSync(fresh)).toBe(true)
})

test('prune respects a custom maxAgeDays', () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
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
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
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
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
  const outside = mkdtempSync(join(tmpdir(), 'kanon-outside-'))
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
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const outside = mkdtempSync(join(tmpdir(), 'kanon-outside-'))
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
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
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
