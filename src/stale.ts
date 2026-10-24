import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { extractNames, type Name } from './names'
import type { Origin } from './types'

export type Level = 'gone' | 'may-be-stale'
export interface Verdict {
  level: Level
  evidence: string
}
export type Scope = 'repo' | 'disk' | 'none'

/** Everything the judge learns about the world goes through here, so tests can fake it. */
export interface Probe {
  exists(absPath: string): boolean
  /** The subset of `names` that occur in tracked, non-Markdown files. */
  occursInCode(names: string[]): Set<string>
  /** package.json script names at the root, or null when there is no package.json. */
  scripts(): Set<string> | null
  /** Repo-relative paths among `paths` with a commit after `since`; empty when not a git repo. */
  changedSince(paths: string[], since: Date): string[]
  /** Repo-relative paths of every tracked file, or null when unknown (not a repo, git failed). */
  trackedPaths(): string[] | null
  /** The subset of repo-relative `paths` git would ignore; all of them when unknown. */
  ignored(paths: string[]): Set<string>
}

export interface Item {
  path: string
  origin: Origin
  kind: 'instruction' | 'memory'
  written: Date
  text: string
}

/**
 * How far a claim in this item can be checked. A memory is about this
 * checkout whoever wrote it; a user-level file is about the machine, not any
 * one repository, so only paths on disk say anything; managed and foreign
 * files are not the user's to correct.
 */
export function scopeOf(item: Pick<Item, 'kind' | 'origin'>): Scope {
  if (item.kind === 'memory') return 'repo'
  switch (item.origin) {
    case 'project':
    case 'local':
      return 'repo'
    case 'user':
      return 'disk'
    default:
      return 'none'
  }
}

/** A `~/` or absolute name, which means one place on disk whatever the item. */
function isPinned(text: string): boolean {
  return text.startsWith('~/') || isAbsolute(text)
}

/**
 * Every place a named path may point, in the order they are tried: `~/`
 * against home, an absolute path as is, anything else against the repo root
 * and then the item's own directory. `@`-prefixed names are packages, not
 * files, and point nowhere. Shared with steering.ts, so the file an
 * acknowledgement digests is the file the verdict was judged on.
 */
export function nameCandidates(text: string, itemPath: string, root: string, home: string): string[] {
  if (text.startsWith('@')) return []
  if (text.startsWith('~/')) return [join(home, text.slice(2))]
  if (isAbsolute(text)) return [text]
  return [resolve(root, text), resolve(dirname(itemPath), text)]
}

const gone = (text: string): Verdict => ({ level: 'gone', evidence: `names \`${text}\`, which no longer exists` })

function judgeDisk(names: Name[], home: string, probe: Probe): Verdict | null {
  for (const n of names) {
    if (n.kind !== 'path' || !isPinned(n.text)) continue
    if (!nameCandidates(n.text, '', '', home).some((p) => probe.exists(p))) return gone(n.text)
  }
  return null
}

/**
 * Whether tracked path `p` matches relative name `text` by whole trailing
 * segments: `a/b.ts` matches `a/b.ts` and `x/a/b.ts`, never `xa/b.ts`. A
 * trailing-slash name is a directory and matches any tracked path inside a
 * directory of that name, wherever it sits.
 */
function tracks(p: string, text: string): boolean {
  const t = text.replace(/^(?:\.\/)+/, '')
  if (t.endsWith('/')) return p.startsWith(t) || p.includes(`/${t}`)
  return p === t || p.endsWith(`/${t}`)
}

/**
 * Whether an extensionless slashed name sits under a directory this repo
 * tracks. `lexer/parser/AST`, `vitest/config`, `fix/some-branch` and
 * `Owner/Repo` are shaped like paths but are a list of words, a module
 * specifier, a branch and a repository, and each was reported gone. A path
 * into this tree starts at one of its directories, so an extensionless
 * name whose first segment is none of them is not judged. A name with an
 * extension or a trailing slash claims a file or directory and is always
 * judged.
 */
function underTrackedDir(text: string, tracked: string[]): boolean {
  const t = text.replace(/^(?:\.\/)+/, '')
  const parts = t.split('/')
  if (!t.includes('/') || t.endsWith('/') || /\.[A-Za-z0-9]{1,5}$/.test(parts[parts.length - 1]!)) return true
  return tracked.some((p) => tracks(p, `${parts[0]}/`))
}

interface Survey {
  /** Where each checkable relative path was found, or null when it was not. */
  found: Map<string, string | null>
  /** Names only a code search can settle. */
  lookups: string[]
  checkable: Name[]
}

function survey(item: Pick<Item, 'path'>, names: Name[], root: string, home: string, probe: Probe): Survey {
  const found = new Map<string, string | null>()
  const lookups: string[] = []
  const checkable: Name[] = []

  for (const n of names) {
    if (n.kind === 'path') {
      // `@types/node` is a package name, not a file. `~/` and absolute paths
      // are judged by existence alone, so repo scope stays a superset of disk
      // scope, and they never go to the code lookup.
      if (n.text.startsWith('@')) continue
      const hit = nameCandidates(n.text, item.path, root, home).find((p) => probe.exists(p)) ?? null
      found.set(n.text, hit)
      if (isPinned(n.text)) {
        checkable.push(n)
        continue
      }
      // `process.env` has a real file extension and no slash, so it is
      // ambiguous: a miss on disk is gone only if no code mentions it either.
      if (!hit && !n.text.includes('/')) lookups.push(n.text)
    } else if (n.kind === 'flag' || n.kind === 'symbol') {
      lookups.push(n.text)
    }
    checkable.push(n)
  }
  return { found, lookups, checkable }
}

/** The names judge() would hand to occursInCode for this item, so a caller can batch them. */
export function codeLookups(item: Omit<Item, 'written'>, root: string, home: string, probe: Probe): string[] {
  if (scopeOf(item) !== 'repo') return []
  try {
    return [...new Set(survey(item, namesOf(item.text, root, home), root, home, probe).lookups)]
  } catch {
    return []
  }
}

function judgeRepo(item: Item, names: Name[], root: string, home: string, probe: Probe): Verdict | null {
  const { found, lookups, checkable } = survey(item, names, root, home, probe)

  const unique = [...new Set(lookups)]
  const inCode = unique.length ? probe.occursInCode(unique) : new Set<string>()
  const scripts = checkable.some((n) => n.kind === 'script') ? probe.scripts() : null

  // A directory name git ignores (`.superpowers/`, `releases/`) is a place
  // for files the project keeps out of the tree, usually named in a rule
  // saying so. It is absent from every fresh checkout, so its absence is not
  // evidence. A named file inside one is still a claim that it is there.
  // One ignore check per item, for the directory names that would be gone.
  const misses = checkable.filter((n) => n.kind === 'path' && found.get(n.text) === null && !isPinned(n.text))
  const tracked = misses.length ? probe.trackedPaths() : null
  const dirs = tracked
    ? misses.filter((n) => n.text.endsWith('/') && !tracked.some((p) => tracks(p, n.text))).map((n) => n.text)
    : []
  const ignored = dirs.length ? probe.ignored(dirs) : new Set<string>()

  // Only a path can be `gone`. A function, flag or script that no longer
  // occurs may have been renamed after the note, or live somewhere grep does
  // not look; asking the user mid-task over that was a reason to switch the
  // tool off (user decision). So the first one missing gives may-be-stale,
  // and only when no named path is gone.
  let missing: Verdict | null = null
  for (const n of checkable) {
    if (n.kind === 'path') {
      if (found.get(n.text) !== null) continue
      if (isPinned(n.text)) return gone(n.text)
      // A slashless name that code mentions (`process.env`) is an identifier.
      if (!n.text.includes('/') && inCode.has(n.text)) continue
      // A relative name is usually written from somewhere inside the tree,
      // not from the root or the item's directory: `normalise.ts` for
      // `src/normalise.ts`, `discover/walk.ts`, or `specs/` for every specs
      // directory. Judging those against two directories alone produced a
      // new false gone each time a note named a file another way, so it is
      // gone only when no tracked path matches it at all. An unknown
      // tracked set is a tooling failure, not evidence.
      if (tracked === null || tracked.some((p) => tracks(p, n.text))) continue
      if (!underTrackedDir(n.text, tracked) || ignored.has(n.text)) continue
      return gone(n.text)
    } else if (missing) {
      continue
    } else if (n.kind === 'script') {
      if (scripts && !scripts.has(n.text)) missing = { level: 'may-be-stale', evidence: `names script \`${n.text}\`, which package.json no longer defines` }
    } else if (!inCode.has(n.text)) {
      missing = { level: 'may-be-stale', evidence: `names \`${n.text}\`, which no longer occurs in the code` }
    }
  }
  if (missing) return missing

  const rel: string[] = []
  for (const hit of found.values()) {
    if (!hit) continue
    const r = relative(root, hit)
    if (r && !r.startsWith('..') && !isAbsolute(r) && !rel.includes(r)) rel.push(r)
  }
  if (!rel.length) return null
  const changed = probe.changedSince(rel, item.written)
  if (!changed.length) return null
  const more = changed.length > 1 ? ` (and ${changed.length - 1} more)` : ''
  return { level: 'may-be-stale', evidence: `\`${changed[0]}\` changed after this was written${more}` }
}

/**
 * Claude Code's own configuration locations. Naming where instructions or
 * settings CAN live is not a claim that a file exists there: a project's
 * CLAUDE.md describing the loader names `~/.claude/CLAUDE.md`, and on a
 * machine with no such file that was reported `gone`. So these are never
 * judged, in any scope.
 *
 * `~/` entries match after `~` resolution, relative entries by their
 * repo-relative spelling, and both by the absolute path either resolves to.
 * A trailing slash exempts the directory itself only, so a named file below
 * it (`~/.claude/rules/foo.md`) is still judged. The managed policy
 * directories exempt everything beneath them.
 */
export const WELL_KNOWN_LOCATIONS = [
  '~/.claude/CLAUDE.md',
  '~/.claude/rules/',
  '~/.claude/settings.json',
  '~/.claude/settings.local.json',
  '~/.claude.json',
  '~/.claude/projects/',
  '~/.claude/plugins/',
  '.claude/CLAUDE.md',
  '.claude/rules/',
  '.claude/settings.json',
  '.claude/settings.local.json',
  'CLAUDE.local.md',
  '.mcp.json',
]
export const MANAGED_POLICY_DIRS = ['/etc/claude-code/', '/Library/Application Support/ClaudeCode/']

/** `~/` against home, anything relative against the root, trailing slash dropped. */
function locate(text: string, root: string, home: string): string {
  const abs = text.startsWith('~/') ? join(home, text.slice(2)) : resolve(root, text)
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs
}

/**
 * `rules/` written for both rules directories was reported gone, so bare
 * `rules/` is shorthand for them, as is a `.claude/...` spelling that ends
 * a well-known location. Nothing broader: bare `CLAUDE.md`, `settings.json`,
 * `plugins/` and `projects/` are common names outside Claude Code, and the
 * tracked-paths rule already keeps them quiet wherever they exist.
 */
function isShorthand(text: string): boolean {
  const t = text.replace(/\/+$/, '')
  if (t === 'rules') return true
  if (!t.startsWith('.claude/')) return false
  return WELL_KNOWN_LOCATIONS.some((w) => {
    const full = w.replace(/^~\//, '').replace(/\/+$/, '')
    return full === t || full.endsWith(`/${t}`)
  })
}

function isWellKnown(text: string, root: string, home: string): boolean {
  const at = locate(text, root, home)
  if (MANAGED_POLICY_DIRS.some((d) => at === d.slice(0, -1) || at.startsWith(d))) return true
  return isShorthand(text) || WELL_KNOWN_LOCATIONS.some((w) => locate(w, root, home) === at)
}

/** The names in an item's text that are claims, leaving out Claude Code's own locations. */
function namesOf(text: string, root: string, home: string): Name[] {
  return extractNames(text).filter((n) => !(n.kind === 'path' && isWellKnown(n.text, root, home)))
}

/**
 * Judge one item from the names it mentions. `gone` means a named path is
 * absent where it should be; `may-be-stale` means a named function, flag or
 * script no longer occurs, or a named file has commits after the item was
 * written. An item naming nothing checkable gets null.
 */
export function judge(item: Item, root: string, home: string, probe: Probe): Verdict | null {
  const scope = scopeOf(item)
  if (scope === 'none') return null
  const names = namesOf(item.text, root, home)
  if (!names.length) return null
  // A probe that throws (git missing, an unreadable file, a malformed
  // package.json) is a tooling failure, not evidence. Reporting `gone` on it
  // would accuse a real file of not existing, so no verdict is the answer.
  try {
    return scope === 'disk' ? judgeDisk(names, home, probe) : judgeRepo(item, names, root, home, probe)
  } catch {
    return null
  }
}
