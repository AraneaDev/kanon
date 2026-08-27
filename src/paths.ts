import { homedir } from 'node:os'
import { relative } from 'node:path'

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
