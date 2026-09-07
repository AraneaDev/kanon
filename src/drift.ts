import { readFileSync } from 'node:fs'
import { tooLarge } from './limits'
import { realPath } from './paths'
import type { Classified, Origin } from './types'

/**
 * Bumped only when the shape below changes. A snapshot whose version this
 * code does not recognise is read as *no baseline*, never as drift: a schema
 * change must degrade to silence rather than announce that every file in the
 * user's canon has moved.
 *
 * Bumped from 2 to 3 for the `present: boolean` -> `state: EntryState` change
 * below: a v2 snapshot's `present` field would otherwise be misread as one of
 * the new state strings (or as `undefined`, which is neither), so it must
 * fail the version guard and read as no baseline rather than as drift.
 */
export const SNAPSHOT_VERSION = 3

export interface FileDigest {
  path: string
  origin: Origin
  /** null when the file could not be read, or is over the size limit. */
  sha256: string | null
}

/**
 * `present` — on disk as of the last commit that touched this entry.
 *
 * `absent-unreported` — gone as of the last commit, and no `diff()` has yet
 * reported it. This is the state a deletion lands in, deliberately short of
 * `vanished` firing immediately: the commit that notices the absence is
 * `report --commit-state`, and the only caller that passes `--commit-state`
 * is `SessionEnd`, whose output `hooks/scripts/session-end.sh` sends to
 * `/dev/null`. If `vanished` fired at the same commit that first recorded
 * the absence, it would fire exactly where nobody can see it, and the older
 * boolean field did precisely that: `present` flipped straight to `false`
 * at commit time, retiring the alarm before any reader had a chance at it.
 *
 * `absent-reported` — gone, and a `diff()` call has already had the chance
 * to report it (whether or not anything was actually reading that output).
 * Once here, the entry is quiet permanently: reporting the same deletion
 * every session forever would bury the alarm that matters under the ones
 * that don't.
 *
 * The transition from `absent-unreported` sits on the commit *after* the one
 * that first noticed the absence, because `diff()` (called by every
 * `report`, `brief` and `notice` run, not only the one that commits) has a
 * full session's worth of chances to surface it before the next commit
 * retires it. That is what "retire only after a reader has seen it" means in
 * practice: not a guarantee of an actual reader, but a guarantee of at least
 * one intervening opportunity, which the old boolean did not provide at all.
 */
export type EntryState = 'present' | 'absent-unreported' | 'absent-reported'

/**
 * A snapshot entry: a digest plus the two facts that make the snapshot a
 * record of the repository rather than of one session.
 *
 * `state` is what turns `vanished` into a transition instead of a boolean
 * flip. Without it a deleted rule is reported every session forever, a
 * branch switch that removes a file reports it gone on the way out and new
 * on the way back, or (the bug the three states exist to close) the report
 * that would have announced a deletion never runs where anyone can read it.
 *
 * `lastSeen` exists only to expire entries that are gone. A file still on
 * disk is never expired, because it may govern a future session.
 */
export interface SnapshotEntry extends FileDigest {
  lastSeen: string
  state: EntryState
}

export interface Snapshot {
  v: number
  root: string
  ruleset: string
  session: string
  t: string
  files: SnapshotEntry[]
}

export interface Drift {
  appeared: FileDigest[]
  vanished: FileDigest[]
  changed: FileDigest[]
}

/**
 * sha256 of a file's bytes, or null when it cannot be read.
 *
 * A hash is provenance, not meaning: it answers "is this the same file as
 * last time" without Kanon forming any view of what the file says. The
 * 4 MiB ceiling is the one Claude Code itself applies, reused so that a file
 * Claude Code would skip is not hashed either.
 *
 * Taken in the cold path, never in record.sh. The hot path stays a sed and
 * an append. The consequence is that the digest describes the file as it is
 * when the report or brief runs, not as it was at the moment it loaded. That
 * is the right answer for drift, whose question is "is what governs me now
 * different from last time", but it is worth knowing before anyone reaches
 * for this hash to answer a different question.
 */
export function hashFile(path: string): string | null {
  if (tooLarge(path)) return null
  try {
    return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * The digest list for a set of classified files, in the order given.
 *
 * Resolved through realpath before anything else touches the path. The
 * observed side (report.ts) already hands this realpathed paths, so this
 * is a no-op there; the predicted side (cli.ts's `predictedFiles`) does
 * not, since `walkCandidates` only `resolve()`s. Without this, a symlinked
 * instruction file (a `~/.claude/CLAUDE.md` pointed at a dotfiles repo is
 * the common case) digests to two different path strings depending on
 * which side computed it, and `diff()` reports the same never-changed file
 * as `appeared` every single session -- forever, since neither side's path
 * ever moves. Doing it once here means neither caller has to remember to.
 */
export function digest(files: Classified[]): FileDigest[] {
  return files.map((f) => {
    const path = realPath(f.path)
    return { path, origin: f.origin, sha256: hashFile(path) }
  })
}

/**
 * What changed between the snapshot and the current set.
 *
 * `appeared` is "absent from the snapshot entirely", which now means never
 * seen governing this root before. A path the snapshot already carries is
 * never new, whether or not this session loaded it and whether or not it is
 * currently on disk. That single fact is what stops a nested
 * `subdir/CLAUDE.md` being announced every time a session finally enters
 * that directory.
 *
 * `vanished` does not consult `current` at all. It fires for an entry in
 * `absent-unreported` state whose path `exists()` also says is gone --
 * checking disk as well as state is required, not belt and braces: a file
 * that came back between the commit that noticed its absence and this read
 * must not be announced as gone, and disk is the only place that shows it
 * came back. It deliberately does not fire for `present` (nothing has
 * noticed an absence yet) or `absent-reported` (already surfaced once,
 * see `EntryState`'s doc comment for why that state exists at all).
 * Reading "not in this run's set" as "deleted" was the older mistake, and it
 * was wrong on both bases -- observed, because the set is only what loaded
 * this session; predicted, because the set is only what layer two currently
 * expects.
 *
 * No filesystem access here. The caller injects `exists`, the same way
 * `brief()` takes an injected excerpt function, so these tests need no temp
 * directory. A null previous means no baseline, which yields three empty
 * lists rather than a claim that everything appeared.
 *
 * `changed` carries the *current* digest, because that is the one a reader
 * would go and look at.
 */
export function diff(
  previous: SnapshotEntry[] | null,
  current: FileDigest[],
  exists: (path: string) => boolean,
): Drift {
  const empty: Drift = { appeared: [], vanished: [], changed: [] }
  if (previous === null) return empty

  const before = new Map(previous.map((f) => [f.path, f]))

  const drift: Drift = { appeared: [], vanished: [], changed: [] }
  for (const f of current) {
    const was = before.get(f.path)
    if (was === undefined) {
      drift.appeared.push(f)
      continue
    }
    // An unknown is not a "no": a file that merely became unreadable must
    // not be reported as rewritten.
    if (was.sha256 !== null && f.sha256 !== null && was.sha256 !== f.sha256) drift.changed.push(f)
  }
  for (const f of previous) {
    if (f.state === 'absent-unreported' && !exists(f.path)) drift.vanished.push(f)
  }
  return drift
}

export function driftIsEmpty(d: Drift): boolean {
  return d.appeared.length === 0 && d.vanished.length === 0 && d.changed.length === 0
}

/**
 * How long an entry survives after its file leaves the disk.
 *
 * Deliberately the same number `prune()` uses in src/limits.ts, so no second
 * retention horizon is invented. The two mechanisms are otherwise unrelated:
 * `prune()` deletes whole snapshot *files* by mtime, this expires individual
 * *entries* by absence.
 */
export const SNAPSHOT_MAX_AGE_DAYS = 90

/**
 * The state a carried-forward entry moves to, given what it was and whether
 * its file is on disk right now.
 *
 * On disk, from any state: back to `present`. Off disk: `present` steps down
 * to `absent-unreported` (noticed, not yet reportable-and-reported), which
 * steps down to `absent-reported` (had its one guaranteed chance at `diff()`
 * during the session between this commit and the last), which stays put.
 * There is deliberately no way back from `absent-reported` to
 * `absent-unreported` except through `present` first: a file cannot be
 * re-announced as vanished without having reappeared and left again.
 */
function nextState(was: EntryState, present: boolean): EntryState {
  if (present) return 'present'
  if (was === 'present') return 'absent-unreported'
  return 'absent-reported'
}

/**
 * The file list for the next snapshot: this session's observations unioned
 * with what the repository already knew.
 *
 * The union is the point. A snapshot built from one session's loads is a
 * description of that session, not of the repository, so the session that
 * visited fewest directories would overwrite a richer record and the next
 * session would announce long-standing files as new.
 *
 * Pure: `exists` and `now` are injected, so this needs no temp directory to
 * test and no clock to stub.
 */
export function merge(
  previous: SnapshotEntry[] | null,
  observed: FileDigest[],
  exists: (path: string) => boolean,
  now: Date,
  maxAgeDays: number = SNAPSHOT_MAX_AGE_DAYS,
): SnapshotEntry[] {
  const stamp = now.toISOString()
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000

  const out: SnapshotEntry[] = observed.map((f) => ({ ...f, lastSeen: stamp, state: 'present' }))
  const seen = new Set(observed.map((f) => f.path))

  for (const was of previous ?? []) {
    if (seen.has(was.path)) continue // this session's observation wins
    const present = exists(was.path)
    const state = nextState(was.state, present)
    // lastSeen must not advance while the file is absent: it is what the
    // expiry below measures from, and refreshing it would keep a deleted
    // file on the books forever.
    const lastSeen = present ? stamp : was.lastSeen
    // A timestamp that cannot be parsed yields NaN, and NaN < cutoff is
    // false, so a malformed entry is kept rather than silently deleted.
    if (!present && Date.parse(lastSeen) < cutoff) continue
    out.push({ ...was, state, lastSeen })
  }

  return out
}
