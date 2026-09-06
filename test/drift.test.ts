import { expect, test } from 'bun:test'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  diff,
  digest,
  driftIsEmpty,
  hashFile,
  merge,
  SNAPSHOT_MAX_AGE_DAYS,
  type FileDigest,
  type SnapshotEntry,
} from '../src/drift'
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

const NOW = new Date('2026-09-06T12:00:00Z')
const NOW_STAMP = '2026-09-06T12:00:00.000Z'
/** 91 days before NOW, so past the 90-day horizon. */
const LONG_AGO = '2026-06-07T12:00:00Z'
/** 10 days before NOW, so well inside it. */
const RECENTLY = '2026-08-27T12:00:00Z'

test('an observed file is recorded present, stamped now', () => {
  const out = merge(null, [d('/repo/CLAUDE.md')], THERE, NOW)
  expect(out).toEqual([
    { path: '/repo/CLAUDE.md', origin: 'project', sha256: 'a', lastSeen: NOW_STAMP, present: true },
  ])
})

/**
 * The union, which is the whole change. A file the previous snapshot knew
 * about survives a session that never loaded it, so the next session does
 * not announce it as new.
 */
test('a previous entry not loaded this session is carried forward', () => {
  const out = merge([entry('/repo/subdir/CLAUDE.md')], [d('/repo/CLAUDE.md')], THERE, NOW)
  expect(out.map((f) => f.path).sort()).toEqual(['/repo/CLAUDE.md', '/repo/subdir/CLAUDE.md'])
})

/**
 * Hashes only ever come from files observed loading. Re-hashing a
 * carried-forward file would make the snapshot a scan of files Kanon never
 * watched load, which is the same category error as building drift from
 * candidates.
 */
test('a carried-forward entry keeps its old hash and origin', () => {
  const old = entry('/repo/vendor/x/CLAUDE.md', { sha256: 'old', origin: 'foreign' })
  const out = merge([old], [], THERE, NOW)
  expect(out[0]?.sha256).toBe('old')
  expect(out[0]?.origin).toBe('foreign')
})

test('an observed file overwrites its carried-forward entry', () => {
  const out = merge([entry('/repo/CLAUDE.md', { sha256: 'old' })], [d('/repo/CLAUDE.md', 'new')], THERE, NOW)
  expect(out).toHaveLength(1)
  expect(out[0]?.sha256).toBe('new')
})

test('a carried-forward file still on disk is stamped now and stays present', () => {
  const out = merge([entry('/repo/quiet.md', { lastSeen: LONG_AGO })], [], THERE, NOW)
  expect(out[0]?.present).toBe(true)
  expect(out[0]?.lastSeen).toBe(NOW_STAMP)
})

/**
 * lastSeen must NOT advance for an absent file: that value is what the
 * expiry measures from, so refreshing it would keep a deleted file forever.
 */
test('a carried-forward file absent from disk keeps its old lastSeen', () => {
  const out = merge([entry('/repo/gone.md', { lastSeen: RECENTLY })], [], GONE, NOW)
  expect(out[0]?.present).toBe(false)
  expect(out[0]?.lastSeen).toBe(RECENTLY)
})

test('an absent file inside the horizon is kept', () => {
  const out = merge([entry('/repo/gone.md', { lastSeen: RECENTLY })], [], GONE, NOW)
  expect(out).toHaveLength(1)
})

test('an absent file past the horizon is dropped', () => {
  expect(merge([entry('/repo/gone.md', { lastSeen: LONG_AGO })], [], GONE, NOW)).toEqual([])
})

/**
 * A file that still exists may govern a future session, so age never
 * expires it. Only absence does.
 */
test('a present file is never expired however old its lastSeen', () => {
  const out = merge([entry('/repo/ancient.md', { lastSeen: '2020-01-01T00:00:00Z' })], [], THERE, NOW)
  expect(out).toHaveLength(1)
})

/**
 * An unparseable timestamp must not silently delete a record. Keeping is
 * the safe direction.
 */
test('an entry with an unparseable lastSeen is kept rather than dropped', () => {
  const out = merge([entry('/repo/odd.md', { lastSeen: 'not a date' })], [], GONE, NOW)
  expect(out).toHaveLength(1)
})

test('the horizon matches the one prune() already uses', () => {
  expect(SNAPSHOT_MAX_AGE_DAYS).toBe(90)
})
