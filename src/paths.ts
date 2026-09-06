import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative } from 'node:path'

/**
 * realpath, falling back to the path as given when it cannot be resolved.
 *
 * Shared rather than duplicated per module: `origin.ts` and `report.ts` each
 * carried their own copy, and a third private copy was about to be added in
 * `cli.ts`'s `notice` branch, which is exactly the drift `short()` below
 * already exists to prevent between the two renderers. Every comparison that
 * needs both sides resolved -- `sessionRoot` against `classify`'s argument,
 * a loaded path against the session root before `short()` renders it -- must
 * use this one function, or a symlinked path (pnpm's `node_modules` layout,
 * macOS's `/tmp` and `/var`) prints in full instead of relative, or worse,
 * classifies as `foreign` when it is not.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Shorten a path for display: under the session root it is shown relative
 * to that root (e.g. a `project` file becomes `CLAUDE.md`); otherwise,
 * under the user's home directory, it is shown as `~/...`; otherwise it is
 * shown in full, because a relative path that has to walk back out of the
 * root (`../../etc`) is harder to read than the absolute one.
 *
 * Root-relative is checked first: the session root is very often itself a
 * subdirectory of the home directory (e.g. `~/myproject`), and a project
 * file must render as `CLAUDE.md`, not `~/myproject/CLAUDE.md`.
 *
 * Shared by both renderers so the human report and the Claude-facing brief
 * can never disagree about what to call the same file.
 */
export function short(path: string, root: string): string {
  const rel = relative(root, path)
  if (rel && !rel.startsWith('..')) return rel

  const home = homedir()
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`
  }
  return path
}
