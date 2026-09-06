import { readFileSync } from 'node:fs'
import { tooLarge } from './limits'
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

/** The digest list for a set of classified files, in the order given. */
export function digest(files: Classified[]): FileDigest[] {
  return files.map((f) => ({ path: f.path, origin: f.origin, sha256: hashFile(f.path) }))
}

/**
 * What changed between two digest lists.
 *
 * Pure, with no filesystem access, so its tests need no temp directory and
 * so the caller stays responsible for the one rule that *is* a filesystem
 * question: the brief reports a `vanished` file only when it is absent from
 * disk (see cli.ts). A null previous means no baseline, which yields three
 * empty lists rather than a claim that everything appeared.
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

export function driftIsEmpty(d: Drift): boolean {
  return d.appeared.length === 0 && d.vanished.length === 0 && d.changed.length === 0
}
