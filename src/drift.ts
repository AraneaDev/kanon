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
export const SNAPSHOT_VERSION = 1

export interface FileDigest {
  path: string
  origin: Origin
  /** null when the file could not be read, or is over the size limit. */
  sha256: string | null
}

export interface Snapshot {
  v: number
  root: string
  ruleset: string
  session: string
  t: string
  files: FileDigest[]
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
 * What changed between two digest lists.
 *
 * Pure, with no filesystem access, so its tests need no temp directory and
 * so the caller stays responsible for the one rule that *is* a filesystem
 * question: a `vanished` entry is reported only when the file is actually
 * absent from disk (see `verified()` below). That rule applies to both the
 * observed and the predicted basis alike -- see `verified()`'s own comment
 * for why this diff function must not try to apply it itself. A null
 * previous means no baseline, which yields three empty lists rather than a
 * claim that everything appeared.
 *
 * `changed` carries the *current* digest, because that is the one a reader
 * would go and look at.
 */
export function diff(previous: FileDigest[] | null, current: FileDigest[]): Drift {
  const empty: Drift = { appeared: [], vanished: [], changed: [] }
  if (previous === null) return empty

  const before = new Map(previous.map((f) => [f.path, f]))
  const after = new Map(current.map((f) => [f.path, f]))

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
    if (!after.has(f.path)) drift.vanished.push(f)
  }
  return drift
}

/**
 * Narrow `vanished` to entries that are actually gone from disk.
 *
 * `diff()` only knows "present in the previous digest list, absent from the
 * current one" -- and "the current one" is never the user's whole canon,
 * on either basis. Observed, it's "what loaded THIS session": a nested
 * `subdir/CLAUDE.md` a sibling session visited and this one never entered
 * is absent from today's set without being gone from the repository.
 * Predicted, it's "what layer two currently predicts": a file the loader
 * model stopped expecting has not left the user's canon either. Both are
 * the same mistake -- reading "not in this run's set" as "deleted" -- so
 * the fix is the same rule for both, not a basis-specific gate. This used
 * to live only in cli.ts, scoped to the predicted basis alone, on the
 * argument that a file still present but no longer predicted is a change
 * in layer two rather than in the canon; that argument holds identically
 * for a file merely not loaded this session, so the observed basis needs
 * it too. "Absent from disk" is the one fact neither a session nor a model
 * is party to, which is what makes it the honest, universal test -- and
 * the actionable case: the rule you relied on was actually deleted.
 *
 * `diff()` itself stays pure with no filesystem access; the caller injects
 * `exists`, the same way `brief()` takes an injected excerpt function.
 */
export function verified(drift: Drift, exists: (path: string) => boolean): Drift {
  return { ...drift, vanished: drift.vanished.filter((f) => !exists(f.path)) }
}

export function driftIsEmpty(d: Drift): boolean {
  return d.appeared.length === 0 && d.vanished.length === 0 && d.changed.length === 0
}
