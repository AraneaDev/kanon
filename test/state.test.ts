import { expect, test } from 'bun:test'
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SNAPSHOT_VERSION, type Snapshot } from '../src/drift'
import {
  ackPath,
  readAcks,
  readSnapshot,
  readSteering,
  readWarned,
  readWatermark,
  snapshotPath,
  steeringPath,
  warnedPath,
  writeAcks,
  writeSnapshot,
  writeSteering,
  writeWarned,
  writeWatermark,
} from '../src/state'
import { JUDGE, JUDGE_RULES } from '../src/stale'
import type { Ack, Steered } from '../src/steering'
import pkg from '../package.json'
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
  writeSteering(home, '/repo', [steered])
  writeAcks(home, '/repo', [ack])
  writeWarned(home, 'abc', { epoch: 1, paths: ['/repo/CLAUDE.md'] })
  const names = readdirSync(join(home, 'state'))
  expect(names.length).toBe(5)
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

const steered: Steered = {
  path: '/repo/CLAUDE.md',
  kind: 'instruction',
  origin: 'project',
  digest: 'd1',
  verdict: { level: 'gone', evidence: 'names `src/x.ts`, which no longer exists' },
  acknowledged: false,
}
const ack: Ack = { path: '/repo/CLAUDE.md', digest: 'd1', named: { 'src/x.ts': null }, t: '2026-10-24T00:00:00.000Z' }

function corrupt(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

test('the steering cache round trips, per root', () => {
  const home = tmp('kanon-state-')
  expect(readSteering(home, '/repo')).toBeNull()
  writeSteering(home, '/repo', [steered])
  expect(readSteering(home, '/repo')).toEqual([steered])
  expect(readSteering(home, '/other')).toBeNull()
  const file = JSON.parse(readFileSync(steeringPath(home, '/repo'), 'utf8'))
  expect(file.v).toBe(1)
  expect(file.root).toBe('/repo')
  expect(typeof file.t).toBe('string')
})

test('a malformed or wrong-version steering cache reads as absent', () => {
  const home = tmp('kanon-state-')
  for (const text of ['{ not json', 'null', '[]', JSON.stringify({ v: 2, root: '/repo', t: 'x', items: [] }), JSON.stringify({ v: 1, root: '/repo', t: 'x', items: 'no' })]) {
    corrupt(steeringPath(home, '/repo'), text)
    expect(readSteering(home, '/repo')).toBeNull()
  }
})

test('a steering cache written by other judging code reads as absent', () => {
  const home = tmp('kanon-state-')
  writeSteering(home, '/repo', [steered])
  const file = JSON.parse(readFileSync(steeringPath(home, '/repo'), 'utf8'))
  expect(file.judge).toBe(JUDGE)
  expect(readSteering(home, '/repo')).toEqual([steered])
  // An older build's verdicts, or a file from before the stamp existed.
  for (const judge of ['0.0.1+0', undefined, 7]) {
    corrupt(steeringPath(home, '/repo'), JSON.stringify({ ...file, judge }))
    expect(readSteering(home, '/repo')).toBeNull()
  }
})

test('the judge stamp names the plugin version and the rules revision', () => {
  expect(JUDGE).toBe(`${pkg.version}+${JUDGE_RULES}`)
  expect(JUDGE_RULES).toBeGreaterThanOrEqual(1)
})

test('acknowledgements round trip, and anything unreadable is none', () => {
  const home = tmp('kanon-state-')
  expect(readAcks(home, '/repo')).toEqual([])
  writeAcks(home, '/repo', [ack])
  expect(readAcks(home, '/repo')).toEqual([ack])
  for (const text of ['{ not json', JSON.stringify({ v: 9, root: '/repo', acks: [ack] }), JSON.stringify({ v: 1, root: '/repo', acks: {} })]) {
    corrupt(ackPath(home, '/repo'), text)
    expect(readAcks(home, '/repo')).toEqual([])
  }
})

test('the warned record round trips, and anything unreadable is epoch 0 with nothing warned', () => {
  const home = tmp('kanon-state-')
  expect(readWarned(home, 'abc')).toEqual({ epoch: 0, paths: [] })
  writeWarned(home, 'abc', { epoch: 2, paths: ['/repo/CLAUDE.md'] })
  expect(readWarned(home, 'abc')).toEqual({ epoch: 2, paths: ['/repo/CLAUDE.md'] })
  for (const text of ['garbage', JSON.stringify({ v: 1, epoch: 'x', paths: [] }), JSON.stringify({ v: 1, epoch: 1, paths: [3] })]) {
    corrupt(warnedPath(home, 'abc'), text)
    expect(readWarned(home, 'abc')).toEqual({ epoch: 0, paths: [] })
  }
})

test('a steering cache keeps its good items and drops malformed ones', () => {
  const home = tmp('kanon-state-')
  const bad = [null, { ...steered, kind: 'other' }, { ...steered, verdict: { level: 'x', evidence: 'e' } }, { ...steered, acknowledged: 'no' }, { ...steered, digest: 3 }]
  corrupt(steeringPath(home, '/repo'), JSON.stringify({ v: 1, root: '/repo', judge: JUDGE, t: 'x', items: [steered, ...bad, { ...steered, verdict: null, digest: null }] }))
  expect(readSteering(home, '/repo')).toEqual([steered, { ...steered, verdict: null, digest: null }])
})

test('acknowledgements keep the well-formed entries only', () => {
  const home = tmp('kanon-state-')
  const { named: _named, ...noNamed } = ack
  const bad = [null, noNamed, { ...ack, path: 1 }, { ...ack, digest: 2 }, { ...ack, named: [] }, { ...ack, named: { a: 3 } }, { ...ack, t: null }]
  corrupt(ackPath(home, '/repo'), JSON.stringify({ v: 1, root: '/repo', acks: [...bad, ack, { ...ack, digest: null }] }))
  expect(readAcks(home, '/repo')).toEqual([ack, { ...ack, digest: null }])
})
