import { expect, test } from 'bun:test'
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SNAPSHOT_VERSION, type Snapshot } from '../src/drift'
import { readSnapshot, readWatermark, snapshotPath, writeSnapshot, writeWatermark } from '../src/state'
import { tmp } from './tmp'

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    v: SNAPSHOT_VERSION,
    root: '/repo',
    ruleset: '2026-08',
    session: 'abc',
    t: '2026-09-06T00:00:00Z',
    files: [
      {
        path: '/repo/CLAUDE.md',
        origin: 'project',
        sha256: 'x',
        lastSeen: '2026-09-06T00:00:00Z',
        state: 'present',
      },
    ],
    ...over,
  }
}

test('a snapshot round trips', () => {
  const home = tmp('kanon-state-')
  writeSnapshot(home, snap())
  expect(readSnapshot(home, '/repo')).toEqual(snap())
})

test('no snapshot for a root reads as no baseline', () => {
  expect(readSnapshot(tmp('kanon-state-'), '/repo')).toBeNull()
})

/**
 * A session that recorded nothing is an unobserved session, not a session
 * where the user's canon became empty. Writing files: [] would make every
 * file in the next session read as `appeared`.
 */
test('an empty snapshot never overwrites an existing one', () => {
  const home = tmp('kanon-state-')
  writeSnapshot(home, snap())
  writeSnapshot(home, snap({ session: 'later', files: [] }))
  expect(readSnapshot(home, '/repo')?.session).toBe('abc')
})

test('an empty snapshot for a root with no baseline writes nothing at all', () => {
  const home = tmp('kanon-state-')
  writeSnapshot(home, snap({ files: [] }))
  expect(readSnapshot(home, '/repo')).toBeNull()
})

test('an unrecognised version reads as no baseline, not as drift', () => {
  const home = tmp('kanon-state-')
  writeSnapshot(home, snap())
  writeFileSync(snapshotPath(home, '/repo'), JSON.stringify(snap({ v: 99 })))
  expect(readSnapshot(home, '/repo')).toBeNull()
})

/**
 * The previous schema. Drift shipped nothing to users at v1, but a
 * development machine may hold one, and it must read as "no baseline"
 * rather than as a repository whose entire canon moved.
 */
test('a v1 snapshot reads as no baseline', () => {
  const home = tmp('kanon-state-')
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(snapshotPath(home, '/repo'), JSON.stringify({ ...snap(), v: 1 }))
  expect(readSnapshot(home, '/repo')).toBeNull()
})

/**
 * v2 predates the `present: boolean` -> `state: EntryState` change (whole-
 * branch review, fix 1). Its entries carry `present` rather than `state`, so
 * reading one in as v3 would leave every entry with `state: undefined`,
 * which is neither a recognised EntryState nor caught by any guard downstream
 * -- diff()'s `f.state === 'absent-unreported'` check would simply, silently,
 * never match. The version bump is what turns that into an honest "no
 * baseline" instead.
 */
test('a v2 snapshot reads as no baseline', () => {
  const home = tmp('kanon-state-')
  mkdirSync(join(home, 'state'), { recursive: true })
  const v2 = { ...snap(), v: 2, files: [{ ...snap().files[0], present: true }] }
  writeFileSync(snapshotPath(home, '/repo'), JSON.stringify(v2))
  expect(readSnapshot(home, '/repo')).toBeNull()
})

test('malformed JSON reads as no baseline', () => {
  const home = tmp('kanon-state-')
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(snapshotPath(home, '/repo'), '{ not json')
  expect(readSnapshot(home, '/repo')).toBeNull()
})

/**
 * prune() skips anything that is not a regular file and never recurses, so
 * a subdirectory under state/ would never be swept and would grow forever.
 *
 * `expect(name).not.toContain('/')` (the original form of this test) passes
 * against any implementation -- readdirSync never returns a path separator
 * -- so it could never fail and proved nothing. lstatSync (never statSync,
 * so a symlinked entry is judged by what it is, not what it points at) is
 * what actually exercises the property: a directory or a symlink under
 * state/ would fail this and stay invisible to prune() forever.
 */
test('state files are flat regular files directly under state/', () => {
  const home = tmp('kanon-state-')
  writeSnapshot(home, snap())
  writeWatermark(home, 'abc', 12)
  const names = readdirSync(join(home, 'state'))
  expect(names.length).toBe(2)
  for (const name of names) {
    expect(lstatSync(join(home, 'state', name)).isFile()).toBe(true)
  }
})

test('two roots get two snapshots', () => {
  const home = tmp('kanon-state-')
  writeSnapshot(home, snap({ root: '/a' }))
  writeSnapshot(home, snap({ root: '/b' }))
  expect(readSnapshot(home, '/a')?.root).toBe('/a')
  expect(readSnapshot(home, '/b')?.root).toBe('/b')
})

test('a watermark round trips and an absent one reads as zero', () => {
  const home = tmp('kanon-state-')
  expect(readWatermark(home, 'abc')).toBe(0)
  writeWatermark(home, 'abc', 42)
  expect(readWatermark(home, 'abc')).toBe(42)
})

test('a corrupt watermark reads as zero rather than NaN', () => {
  const home = tmp('kanon-state-')
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'state', 'abc.turn'), 'garbage')
  expect(readWatermark(home, 'abc')).toBe(0)
})
