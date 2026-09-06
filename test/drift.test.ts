import { expect, test } from 'bun:test'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diff, digest, driftIsEmpty, hashFile, type FileDigest, type SnapshotEntry } from '../src/drift'
import type { Classified } from '../src/types'
import { tmp } from './tmp'

function classified(path: string): Classified {
  return { path, origin: 'project', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null }
}

function d(path: string, sha256: string | null = 'a'): FileDigest {
  return { path, origin: 'project', sha256 }
}

function entry(path: string, over: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    path,
    origin: 'project',
    sha256: 'a',
    lastSeen: '2026-09-06T00:00:00Z',
    present: true,
    ...over,
  }
}

const GONE = () => false
const THERE = () => true

test('no baseline yields no drift, never "everything appeared"', () => {
  const drift = diff(null, [d('/repo/CLAUDE.md')], () => false)
  expect(drift).toEqual({ appeared: [], vanished: [], changed: [] })
  expect(driftIsEmpty(drift)).toBe(true)
})

test('a path only in current appeared', () => {
  const drift = diff([entry('/repo/old.md')], [d('/repo/new.md')], THERE)
  expect(drift.appeared.map((f) => f.path)).toEqual(['/repo/new.md'])
  expect(drift.changed).toEqual([])
})

test('a differing hash on both sides is changed, and reports the current digest', () => {
  const drift = diff([entry('/repo/CLAUDE.md', { sha256: 'old' })], [d('/repo/CLAUDE.md', 'new')], THERE)
  expect(drift.changed).toEqual([d('/repo/CLAUDE.md', 'new')])
  expect(drift.appeared).toEqual([])
  expect(drift.vanished).toEqual([])
})

test('an identical hash is not reported at all', () => {
  expect(driftIsEmpty(diff([entry('/repo/CLAUDE.md', { sha256: 'x' })], [d('/repo/CLAUDE.md', 'x')], THERE))).toBe(
    true,
  )
})

/**
 * A null hash is an unknown, not a "no". Reporting it as changed would turn
 * a file that merely became unreadable into a false alarm, which is the one
 * direction this tool must never fail in.
 */
test('a null hash on either side is never changed', () => {
  expect(
    driftIsEmpty(diff([entry('/repo/CLAUDE.md', { sha256: null })], [d('/repo/CLAUDE.md', 'x')], THERE)),
  ).toBe(true)
  expect(
    driftIsEmpty(diff([entry('/repo/CLAUDE.md', { sha256: 'x' })], [d('/repo/CLAUDE.md', null)], THERE)),
  ).toBe(true)
  expect(
    driftIsEmpty(diff([entry('/repo/CLAUDE.md', { sha256: null })], [d('/repo/CLAUDE.md', null)], THERE)),
  ).toBe(true)
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

/**
 * Fix 1 (whole-branch review): the observed side of a snapshot is already
 * realpathed by the time it reaches digest() (report.ts resolves loaded
 * paths before classifying them), but the predicted side in cli.ts hands
 * digest() `c.path` straight from walkCandidates, which only `resolve()`s
 * and never realpaths. A symlinked `~/.claude/CLAUDE.md` (a dotfiles
 * checkout is the common case) then digests to two different path strings
 * depending on which side computed it, so diff() sees the file vanish and
 * reappear under a new name every single session -- a permanent false
 * `appeared` for a file that never changed. digest() must resolve for
 * itself so neither caller has to remember to.
 */
test('digest resolves a symlink, so the same file names the same way from either side', () => {
  const dir = tmp('kanon-drift-symlink-')
  const target = join(dir, 'CLAUDE.md')
  writeFileSync(target, '# real file\n')
  const link = join(dir, 'link.md')
  symlinkSync(target, link)

  const viaLink = digest([classified(link)])
  const viaTarget = digest([classified(target)])

  expect(viaLink[0]?.path).toBe(viaTarget[0]?.path)
})

/**
 * The whole point of the repository snapshot. A file Kanon already knows
 * about is never new, whether or not this session happened to load it.
 */
test('a path already in the snapshot is never appeared, even when absent from the current set', () => {
  const drift = diff([entry('/repo/subdir/CLAUDE.md')], [], THERE)
  expect(drift.appeared).toEqual([])
})

test('a path already in the snapshot is never appeared when it loads again', () => {
  const drift = diff([entry('/repo/subdir/CLAUDE.md')], [d('/repo/subdir/CLAUDE.md')], THERE)
  expect(drift.appeared).toEqual([])
})

/**
 * `vanished` is a transition, not a state: it fires when a file Kanon last
 * saw on disk is gone. It must not consult the current set at all, or a
 * session that simply never entered a subdirectory would report that
 * subdirectory's rule as deleted.
 */
test('vanished fires for a previously present file now absent from disk', () => {
  const drift = diff([entry('/repo/gone.md', { present: true })], [], GONE)
  expect(drift.vanished.map((f) => f.path)).toEqual(['/repo/gone.md'])
})

test('vanished does not fire for a file that is still on disk', () => {
  expect(driftIsEmpty(diff([entry('/repo/quiet.md', { present: true })], [], THERE))).toBe(true)
})

/**
 * The second half of the transition. Once an absent file has been reported
 * its entry carries present: false, so it must never be reported again.
 */
test('vanished does not fire twice for a file already known to be absent', () => {
  expect(driftIsEmpty(diff([entry('/repo/gone.md', { present: false })], [], GONE))).toBe(true)
})

test('a file restored after being recorded absent is not appeared', () => {
  const drift = diff([entry('/repo/back.md', { present: false })], [d('/repo/back.md')], THERE)
  expect(drift.appeared).toEqual([])
  expect(drift.vanished).toEqual([])
})

test('diff performs no filesystem access, so a fabricated path is fine', () => {
  const drift = diff([entry('/nowhere/at/all.md')], [], GONE)
  expect(drift.vanished.map((f) => f.path)).toEqual(['/nowhere/at/all.md'])
})
