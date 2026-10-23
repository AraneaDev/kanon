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
  // Computed on first use, then kept for the probe's lifetime: one
  // `ls-files` per session start, however many names ask.
  let tracked: string[] | null | undefined
  return {
    exists,

    trackedPaths() {
      if (tracked !== undefined) return tracked
      tracked = null
      const r = git(root, ['ls-files', '-z'])
      if (r && r.code === 0) tracked = r.out.split('\0').filter(Boolean)
      return tracked
    },

    occursInCode(names) {
      // An empty pattern matches every line, and a newline would split one
      // name into two patterns. Neither can be searched, so neither can be
      // called missing.
      const searchable = names.filter((n) => n !== '' && !/[\r\n]/.test(n))
      const unsearchable = names.filter((n) => n === '' || /[\r\n]/.test(n))
      if (!searchable.length) return new Set(names)
      let dir: string | null = null
      try {
        dir = mkdtempSync(join(tmpdir(), 'kanon-grep-'))
        const file = join(dir, 'patterns')
        writeFileSync(file, searchable.join('\n') + '\n')
        // No `-o`: it reports only the leftmost-longest match at each
        // position, so `foo` inside `foobar` would read as absent. Whole
        // lines, checked with includes(), have no such blind spot. `-I`
        // skips binary files, which only ever report "Binary file x matches".
        const r = git(root, ['grep', '-F', '-h', '-I', '--no-color', '-f', file, '--', '.', ':!*.md'])
        if (!r) return new Set(names)
        if (r.code === 1) return new Set(unsearchable)
        // Not a repo, or grep itself broke: say nothing is missing rather
        // than invent a `gone` from a tool failure.
        if (r.code !== 0) return new Set(names)
        const lines = r.out.split('\n').filter(Boolean)
        return new Set([...unsearchable, ...searchable.filter((n) => lines.some((l) => l.includes(n)))])
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
