import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * Claude Code loads a CLAUDE.md up to 4 MiB. Since 2.1.309 a nested one over
 * the limit loads by its start rather than being skipped; that is the only
 * case the changelog confirms. Drift and the brief's excerpts read the same
 * start (`readStart`) for any file, which is right for a nested CLAUDE.md and
 * harmless elsewhere. Discovery still reports an oversized rule or import as
 * skipped, since nothing says those load at all.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/**
 * True when `path` exists, resolves (following symlinks, matching how the
 * rest of discovery treats symlinks) to a regular file, and that file is
 * over the limit. A path that cannot be stat'd -- missing, a dangling
 * symlink, a permissions error -- is never "too large": that is a
 * different failure, and the caller's own read (or its absence) is what
 * reports it.
 */
export function tooLarge(path: string): boolean {
  try {
    return statSync(path).size > MAX_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * The first `max` bytes of a file, following symlinks, or null when it cannot
 * be read. This is the part of an oversized instruction file Claude Code
 * actually loads, so it is the part drift hashes and the brief quotes.
 */
export function readStart(path: string, max = MAX_FILE_BYTES): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    // fstat, not stat: the size must come from the file just opened, not
    // from whatever the path names by the time a second lookup runs.
    const buf = Buffer.alloc(Math.min(max, fstatSync(fd).size))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** How much of a transcript is read at a time, from its end. */
export const TRANSCRIPT_CHUNK = 4 * 1024 * 1024
/** The most of a transcript ever read: a run longer than this is read by its last 128 MiB. */
export const TRANSCRIPT_CAP = 128 * 1024 * 1024

/**
 * The end of a file, read backwards `chunk` bytes at a time until `enough`
 * says the chunk just read reaches far enough back, the start of the file is
 * reached, or `cap` bytes have been read; null when it cannot be read.
 *
 * A transcript grows for the whole life of a session and the current run sits
 * at its end, but how far back that run starts is anyone's guess. A fixed
 * 16 MiB tail lost a long run's early records, so a session that invoked
 * several skills read as having invoked none. Each chunk is offered to
 * `enough` on its own, never everything read so far, so judging stays linear
 * in what is read.
 *
 * Wherever the read starts mid-file, everything up to the first newline is a
 * fragment of a record and is dropped, both from what `enough` is shown and
 * from the result, rather than handed to a parser as if it were whole.
 */
export function readBack(path: string, enough: (head: Buffer) => boolean, chunk = TRANSCRIPT_CHUNK, cap = TRANSCRIPT_CAP): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    // fstat, not stat, for the same reason as readStart.
    const size = fstatSync(fd).size
    const floor = Math.max(0, size - cap)
    const parts: Buffer[] = []
    let start = size
    while (start > floor) {
      const from = Math.max(floor, start - Math.max(1, chunk))
      const buf = Buffer.alloc(start - from)
      const got = buf.subarray(0, readSync(fd, buf, 0, buf.length, from))
      parts.unshift(got)
      start = from
      if (start > floor && enough(whole(got, start))) break
    }
    return whole(Buffer.concat(parts), start)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** `buf`, read from `start`, without the fragment of a record before its first newline; whole when it starts the file. */
function whole(buf: Buffer, start: number): Buffer {
  if (start === 0) return buf
  const nl = buf.indexOf(0x0a)
  return nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1)
}

const PRUNED_DIRS = ['sessions', 'state', 'reports']

/**
 * Remove events, state and reports older than maxAgeDays. Returns the
 * paths removed.
 *
 * This runs on every CLI invocation against a real `~/.kanon`, so it is
 * held to a stricter bar than ordinary housekeeping: it must never touch
 * anything outside `kanonHome`, and it must never throw in a way that
 * stops a report being produced (every failure here is swallowed per
 * entry, and the caller wraps the whole call besides).
 *
 * Two checks are what actually keep it inside the fence, both using
 * `lstat` rather than `stat` so a symlink is inspected as itself, never
 * followed:
 *  - each of `sessions`/`state`/`reports` must itself be a real directory.
 *    If one of those names has been replaced by a symlink -- to `/`, say
 *    -- it is skipped rather than traversed, so `readdirSync` is never run
 *    against something outside `kanonHome`.
 *  - each entry inside it must be a regular file. Kanon only ever writes
 *    plain files there, so a symlinked entry is left alone rather than
 *    having its *target's* mtime decide whether to unlink the link, and a
 *    stray subdirectory is never recursed into or removed.
 * The resolved-path containment check below this is not a third defence:
 * it uses `resolve()`, not `realpathSync()`, so it does not see through a
 * symlink in an intermediate path component, and by the time it runs the
 * two `lstat` checks above have already excluded everything that could
 * disagree with it. It is left in as a plain assertion of intent, not
 * load-bearing.
 */
export function prune(kanonHome: string, now: number, maxAgeDays = 90): string[] {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  const removed: string[] = []
  const home = resolve(kanonHome)

  for (const sub of PRUNED_DIRS) {
    const dir = join(home, sub)
    try {
      if (!lstatSync(dir).isDirectory()) continue
    } catch {
      continue
    }

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

    for (const name of entries) {
      const full = join(dir, name)
      try {
        const st = lstatSync(full)
        if (!st.isFile()) continue // symlinks and subdirectories: never followed, never removed
        if (!resolve(full).startsWith(home + sep)) continue // non-load-bearing; see the doc comment above
        if (st.mtimeMs >= cutoff) continue
        rmSync(full, { force: true })
        removed.push(full)
      } catch {
        // A file that cannot be stat'd or removed is left alone.
      }
    }
  }
  return removed
}
