import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diff, driftIsEmpty, hashFile, type FileDigest } from '../src/drift'
import { tmp } from './tmp'

function d(path: string, sha256: string | null = 'a'): FileDigest {
  return { path, origin: 'project', sha256 }
}

test('no baseline yields no drift, never "everything appeared"', () => {
  const drift = diff(null, [d('/repo/CLAUDE.md')])
  expect(drift).toEqual({ appeared: [], vanished: [], changed: [] })
  expect(driftIsEmpty(drift)).toBe(true)
})

test('a path only in current appeared, a path only in previous vanished', () => {
  const drift = diff([d('/repo/old.md')], [d('/repo/new.md')])
  expect(drift.appeared.map((f) => f.path)).toEqual(['/repo/new.md'])
  expect(drift.vanished.map((f) => f.path)).toEqual(['/repo/old.md'])
  expect(drift.changed).toEqual([])
})

test('a differing hash on both sides is changed, and reports the current digest', () => {
  const drift = diff([d('/repo/CLAUDE.md', 'old')], [d('/repo/CLAUDE.md', 'new')])
  expect(drift.changed).toEqual([d('/repo/CLAUDE.md', 'new')])
  expect(drift.appeared).toEqual([])
  expect(drift.vanished).toEqual([])
})

test('an identical hash is not reported at all', () => {
  expect(driftIsEmpty(diff([d('/repo/CLAUDE.md', 'x')], [d('/repo/CLAUDE.md', 'x')]))).toBe(true)
})

/**
 * A null hash is an unknown, not a "no". Reporting it as changed would turn
 * a file that merely became unreadable into a false alarm, which is the one
 * direction this tool must never fail in.
 */
test('a null hash on either side is never changed', () => {
  expect(driftIsEmpty(diff([d('/repo/CLAUDE.md', null)], [d('/repo/CLAUDE.md', 'x')]))).toBe(true)
  expect(driftIsEmpty(diff([d('/repo/CLAUDE.md', 'x')], [d('/repo/CLAUDE.md', null)]))).toBe(true)
  expect(driftIsEmpty(diff([d('/repo/CLAUDE.md', null)], [d('/repo/CLAUDE.md', null)]))).toBe(true)
})

test('hashFile is stable for the same bytes and differs for different bytes', () => {
  const dir = tmp('kanon-drift-')
  const a = join(dir, 'a.md')
  const b = join(dir, 'b.md')
  writeFileSync(a, 'same')
  writeFileSync(b, 'same')
  expect(hashFile(a)).toBe(hashFile(b))
  writeFileSync(b, 'different')
  expect(hashFile(a)).not.toBe(hashFile(b))
})

test('hashFile returns null for a file it cannot read', () => {
  expect(hashFile(join(tmp('kanon-drift-'), 'absent.md'))).toBeNull()
})
