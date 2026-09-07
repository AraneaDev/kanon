import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { realPath } from './paths'
import { DEPENDENCY_SEGMENTS, type Origin } from './types'

const MANAGED = {
  linux: '/etc/claude-code/CLAUDE.md',
  darwin: '/Library/Application Support/ClaudeCode/CLAUDE.md',
  win32: 'C:\\Program Files\\ClaudeCode\\CLAUDE.md',
} as const

export function managedPath(platform: string = process.platform): string {
  return MANAGED[platform as keyof typeof MANAGED] ?? MANAGED.linux
}

/**
 * The git repository root containing cwd, or cwd when it is not in a repo.
 *
 * The result is resolved through realpath, because `classify` realpaths the
 * file paths it is handed and the two have to be comparable. On macOS `/tmp`
 * and `/var` are symlinks into `/private`, so a session started through one of
 * them would otherwise produce a root that none of its own files appear to sit
 * under, and every file in the project would be classified `foreign`. A false
 * FOREIGN alarm is the worst output this tool has, so the two sides are made
 * consistent here rather than at each call site.
 */
export function sessionRoot(cwd: string): string {
  const start = realPath(resolve(cwd))
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return start
    dir = up
  }
}

function isUnder(path: string, parent: string): boolean {
  const p = resolve(path)
  const q = resolve(parent)
  return p === q || p.startsWith(q.endsWith(sep) ? q : q + sep)
}

/**
 * True when `path` runs through a dependency directory (`node_modules`,
 * `vendor`, and the like) relative to `root`. Exported so callers outside
 * origin classification -- report.ts's modelDisagrees check, in particular
 * -- can tell "expected to be unenumerated" apart from a genuine miss by
 * the candidate model, without duplicating this walk.
 */
export function hasDependencySegment(path: string, root: string): boolean {
  const rel = isUnder(path, root) ? path.slice(root.length) : path
  return rel.split(sep).some((seg) => DEPENDENCY_SEGMENTS.includes(seg))
}

/**
 * Exactly one origin per file, first match wins. Reaching a file through an
 * import is not an origin; it is recorded separately as viaImport.
 */
export function classify(path: string, root: string, homeConfig: string): Origin {
  // The shared resolver, not a local one: every path comparison in this
  // codebase has to resolve both sides the same way, and a second copy is how
  // two of them drift apart. It falls back to the path as given, which is what
  // a file reported loaded and then removed needs.
  const p = realPath(resolve(path))

  if (p === managedPath()) return 'managed'
  if (isUnder(p, homeConfig)) return 'user'
  if (hasDependencySegment(p, root)) return 'foreign'
  if (!isUnder(p, root)) return 'foreign'
  if (basename(p) === 'CLAUDE.local.md') return 'local'
  return 'project'
}
