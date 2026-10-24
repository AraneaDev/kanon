import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Probe } from './stale'

/**
 * How long one git spawn may run. Session start has a 5 s hook timeout and
 * a killed hook prints no brief at all, so no single call may eat it: grep
 * scans every tracked file and gets the most, everything else a second. A
 * call that runs out is a tooling failure and reads as unknown.
 */
export const GREP_TIMEOUT_MS = 2000
export const GIT_TIMEOUT_MS = 1000

export interface ProbeOptions {
  /** The git executable; tests substitute a slow one. */
  git?: string
  timeouts?: { grep: number; other: number }
  /**
   * Epoch ms after which no git call is started and each answers unknown,
   * and before which each call's timeout is cut to the time left. This is
   * what lets steer()'s judging deadline bound the spawns inside it too.
   */
  deadline?: number
}

/**
 * One git call, or null when it could not answer: not started, killed by
 * its timeout, or past the deadline. Every caller already reads null as
 * unknown, and unknown never produces a `gone`.
 */
function git(root: string, args: string[], input: string | undefined, timeout: number, opts: ProbeOptions): { code: number; out: string } | null {
  const left = opts.deadline === undefined ? timeout : Math.min(timeout, opts.deadline - Date.now())
  if (left <= 0) return null
  try {
    const stdin = input === undefined ? 'ignore' : Buffer.from(input)
    const p = Bun.spawnSync([opts.git ?? 'git', '-C', root, ...args], { stdin, stdout: 'pipe', stderr: 'ignore', timeout: left })
    // A killed process has no exit code; its partial output is not an answer.
    if (p.exitCode === null || p.signalCode || p.exitedDueToTimeout) return null
    return { code: p.exitCode, out: p.stdout.toString() }
  } catch {
    return null
  }
}

/** A literal string as a POSIX extended regex. */
function ereLiteral(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
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
export function gitProbe(root: string, opts: ProbeOptions = {}): Probe {
  const grepMs = opts.timeouts?.grep ?? GREP_TIMEOUT_MS
  const otherMs = opts.timeouts?.other ?? GIT_TIMEOUT_MS
  // Computed on first use, then kept for the probe's lifetime: one
  // `ls-files` per session start, however many names ask.
  let tracked: string[] | null | undefined
  return {
    exists,

    trackedPaths() {
      if (tracked !== undefined) return tracked
      tracked = null
      const r = git(root, ['ls-files', '-z'], undefined, otherMs, opts)
      if (r && r.code === 0) tracked = r.out.split('\0').filter(Boolean)
      return tracked
    },

    ignored(paths) {
      // `--no-index` asks the ignore rules alone, so a name that does not
      // exist is still answered. Exit 1 means none is ignored; anything else
      // but 0 is a failure, and unknown reads as ignored so it is never gone.
      const r = git(root, ['check-ignore', '--no-index', '--stdin', '-z'], paths.join('\0') + '\0', otherMs, opts)
      if (r && r.code === 1) return new Set()
      if (!r || r.code !== 0) return new Set(paths)
      const hit = new Set(r.out.split('\0').filter(Boolean))
      return new Set(paths.filter((p) => hit.has(p)))
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
        // One extended regex: an escaped alternation of every name. git grep
        // tries each pattern line separately against each line of each file,
        // so 300 names as 300 `-F` patterns took 13 s on a 3000-file repo,
        // and even two pattern lines took 1.3 s; the same names as a single
        // alternation took 0.1 s, and eight times as many 0.3 s. Escaping
        // keeps every name literal, as `-F` did.
        writeFileSync(file, searchable.map(ereLiteral).join('|') + '\n')
        // No `-o`: it reports only the leftmost-longest match at each
        // position, so `foo` inside `foobar` would read as absent. Whole
        // lines, checked with includes(), have no such blind spot. `-I`
        // skips binary files, which only ever report "Binary file x matches".
        const r = git(root, ['grep', '-E', '-h', '-I', '--no-color', '-f', file, '--', '.', ':!*.md'], undefined, grepMs, opts)
        if (!r) return new Set(names)
        if (r.code === 1) return new Set(unsearchable)
        // Not a repo, or grep itself broke: say nothing is missing rather
        // than invent a `gone` from a tool failure.
        if (r.code !== 0) return new Set(names)
        // A name holds no newline, so it occurs in some matching line exactly
        // when it occurs in the output as a whole: one search per name over
        // one string, rather than every name against every line.
        return new Set([...unsearchable, ...searchable.filter((n) => r.out.includes(n))])
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
      const r = git(root, ['log', `--since=${since.toISOString()}`, '--format=', '--name-only', '--', ...paths], undefined, otherMs, opts)
      if (!r || r.code !== 0) return []
      return [...new Set(r.out.split('\n').filter(Boolean))]
    },
  }
}

/** The committer date of the last commit touching `path`, or null (uncommitted, not a repo, git failed). */
export function lastCommit(root: string, path: string, deadline?: number): Date | null {
  const r = git(root, ['log', '-1', '--format=%cI', '--', path], undefined, GIT_TIMEOUT_MS, { deadline })
  if (!r || r.code !== 0) return null
  const s = r.out.trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}
