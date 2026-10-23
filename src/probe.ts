import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Probe } from './stale'

function git(root: string, args: string[]): { code: number; out: string } | null {
  try {
    const p = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'ignore' })
    return { code: p.exitCode, out: p.stdout.toString() }
  } catch {
    return null
  }
}

/**
 * Absent only when the filesystem says so. Any other failure (EACCES on a
 * parent directory, say) leaves the answer unknown, and unknown must read as
 * present: tooling trouble must never turn into a `gone` verdict. A dangling
 * symlink is absent, because what it names is.
 */
function exists(absPath: string): boolean {
  try {
    lstatSync(absPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return !(code === 'ENOENT' || code === 'ENOTDIR')
  }
  try {
    statSync(absPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return !(code === 'ENOENT' || code === 'ENOTDIR')
  }
  return true
}

/**
 * The git-backed Probe. Each method is one git spawn at most, never one per
 * name, because session-start staleness work has to fit inside the hook's
 * timeout.
 */
export function gitProbe(root: string): Probe {
  return {
    exists,

    occursInCode(names) {
      if (!names.length) return new Set()
      let dir: string | null = null
      try {
        dir = mkdtempSync(join(tmpdir(), 'kanon-grep-'))
        const file = join(dir, 'patterns')
        writeFileSync(file, names.join('\n') + '\n')
        const r = git(root, ['grep', '-F', '-o', '-h', '--no-color', '-f', file, '--', '.', ':!*.md'])
        if (!r) return new Set(names)
        if (r.code === 1) return new Set()
        // Not a repo, or grep itself broke: say nothing is missing rather
        // than invent a `gone` from a tool failure.
        if (r.code !== 0) return new Set(names)
        const hits = new Set(r.out.split('\n').filter(Boolean))
        return new Set(names.filter((n) => hits.has(n)))
      } catch {
        return new Set(names)
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    },

    scripts() {
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        const s = pkg?.scripts
        if (!s || typeof s !== 'object') return null
        return new Set(Object.keys(s))
      } catch {
        return null
      }
    },

    changedSince(paths, since) {
      if (!paths.length) return []
      const r = git(root, ['log', `--since=${since.toISOString()}`, '--format=', '--name-only', '--', ...paths])
      if (!r || r.code !== 0) return []
      return [...new Set(r.out.split('\n').filter(Boolean))]
    },
  }
}

/** The committer date of the last commit touching `path`, or null (uncommitted, not a repo, git failed). */
export function lastCommit(root: string, path: string): Date | null {
  const r = git(root, ['log', '-1', '--format=%cI', '--', path])
  if (!r || r.code !== 0) return null
  const s = r.out.trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}
