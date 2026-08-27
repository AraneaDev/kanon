import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Claude Code loads a CLAUDE.md up to 4 MiB and skips a larger one. */
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
