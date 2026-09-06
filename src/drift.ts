import { readFileSync } from 'node:fs'
import { tooLarge } from './limits'
import { realPath } from './paths'
import type { Classified, Origin } from './types'

/**
 * Bumped only when the shape below changes. A snapshot whose version this
 * code does not recognise is read as *no baseline*, never as drift: a schema
 * change must degrade to silence rather than announce that every file in the
 * user's canon has moved.
 */
export const SNAPSHOT_VERSION = 2

export interface FileDigest {
  path: string
  origin: Origin
  /** null when the file could not be read, or is over the size limit. */
  sha256: string | null
}

/**
 * A snapshot entry: a digest plus the two facts that make the snapshot a
 * record of the repository rather than of one session.
 *
 * `present` is what turns `vanished` into a transition instead of a state.
 * Without it a deleted rule is reported every session forever, and a branch
 * switch that removes a file reports it gone on the way out and new on the
 * way back.
 *
 * `lastSeen` exists only to expire entries that are gone. A file still on
 * disk is never expired, because it may govern a future session.
 */
export interface SnapshotEntry extends FileDigest {
  lastSeen: string
  present: boolean
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
 * `vanished` does not consult `current` at all. It is the present-to-absent
 * transition: the snapshot last saw the file on disk and it is gone now.
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
    if (f.present && !exists(f.path)) drift.vanished.push(f)
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

  const out: SnapshotEntry[] = observed.map((f) => ({ ...f, lastSeen: stamp, present: true }))
  const seen = new Set(observed.map((f) => f.path))

  for (const was of previous ?? []) {
    if (seen.has(was.path)) continue // this session's observation wins
    const present = exists(was.path)
    // lastSeen must not advance while the file is absent: it is what the
    // expiry below measures from, and refreshing it would keep a deleted
    // file on the books forever.
    const lastSeen = present ? stamp : was.lastSeen
    // A timestamp that cannot be parsed yields NaN, and NaN < cutoff is
    // false, so a malformed entry is kept rather than silently deleted.
    if (!present && Date.parse(lastSeen) < cutoff) continue
    out.push({ ...was, present, lastSeen })
  }

  return out
}
