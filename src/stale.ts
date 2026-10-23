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
export function scopeOf(item: Item): Scope {
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

const gone = (text: string): Verdict => ({ level: 'gone', evidence: `names \`${text}\`, which no longer exists` })

function judgeDisk(names: Name[], home: string, probe: Probe): Verdict | null {
  for (const n of names) {
    if (n.kind !== 'path') continue
    const abs = n.text.startsWith('~/') ? join(home, n.text.slice(2)) : isAbsolute(n.text) ? n.text : null
    if (abs && !probe.exists(abs)) return gone(n.text)
  }
  return null
}

function judgeRepo(item: Item, names: Name[], root: string, home: string, probe: Probe): Verdict | null {
  const dir = dirname(item.path)
  // Where each checkable relative path was found, or null when it was not.
  const found = new Map<string, string | null>()
  const lookups: string[] = []
  const checkable: Name[] = []

  for (const n of names) {
    if (n.kind === 'path') {
      // `@types/node` is a package name, not a file. `~/` and absolute paths
      // are judged by existence alone, so repo scope stays a superset of disk
      // scope, and they never go to the code lookup.
      if (n.text.startsWith('@')) continue
      const abs = n.text.startsWith('~/') ? join(home, n.text.slice(2)) : isAbsolute(n.text) ? n.text : null
      if (abs) {
        found.set(n.text, probe.exists(abs) ? abs : null)
        checkable.push(n)
        continue
      }
      const hit = [resolve(root, n.text), resolve(dir, n.text)].find((p) => probe.exists(p)) ?? null
      found.set(n.text, hit)
      // `process.env` has a real file extension and no slash, so it is
      // ambiguous: a miss on disk is gone only if no code mentions it either.
      if (!hit && !n.text.includes('/')) lookups.push(n.text)
    } else if (n.kind === 'flag' || n.kind === 'symbol') {
      lookups.push(n.text)
    }
    checkable.push(n)
  }

  const unique = [...new Set(lookups)]
  const inCode = unique.length ? probe.occursInCode(unique) : new Set<string>()
  const scripts = checkable.some((n) => n.kind === 'script') ? probe.scripts() : null

  for (const n of checkable) {
    if (n.kind === 'path') {
      if (found.get(n.text) === null && !(inCode.has(n.text) && !n.text.includes('/'))) return gone(n.text)
    } else if (n.kind === 'script') {
      if (scripts && !scripts.has(n.text)) return gone(n.text)
    } else if (!inCode.has(n.text)) {
      return gone(n.text)
    }
  }

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
 * Judge one item from the names it mentions. `gone` means a named thing is
 * absent where it should be; `may-be-stale` means a named file has commits
 * after the item was written. An item naming nothing checkable gets null.
 */
export function judge(item: Item, root: string, home: string, probe: Probe): Verdict | null {
  const scope = scopeOf(item)
  if (scope === 'none') return null
  const names = extractNames(item.text)
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
