import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { managedPath } from '../origin'
import type { Candidate } from '../types'

const PROJECT_FILES = ['CLAUDE.md', 'CLAUDE.local.md']

/**
 * Candidates from the fixed scopes: the managed policy file, the user scope,
 * and every directory from `root` down to cwd. Ordered as Claude Code loads
 * them, broadest first.
 *
 * The walk stops at `root` rather than climbing to the filesystem root. A
 * linked worktree carries a `.git` file, so `sessionRoot` stops there and the
 * worktree is the root; Claude Code does not load the enclosing checkout's
 * CLAUDE.md from inside one (confirmed from a live log, 2026-09-07). Climbing
 * past the root predicted that file in every clean worktree session, which
 * reported it `missing`, and classified it FOREIGN whenever it did load,
 * since it sits outside the root. `root` defaults to cwd's own chain for
 * callers that have no session root to give.
 */
export function walkCandidates(cwd: string, homeConfig: string, root?: string): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()

  const push = (path: string, rule: string): void => {
    const p = resolve(path)
    if (seen.has(p) || !existsSync(p)) return
    seen.add(p)
    out.push({ path: p, label: 'launch', rule })
  }

  push(managedPath(), 'managed-policy')
  push(join(homeConfig, 'CLAUDE.md'), 'user-scope')

  // Ancestors, broadest first so the order matches load order. Bounded below
  // by `root`: a directory above it belongs to a different project as far as
  // Claude Code is concerned.
  const stop = root === undefined ? undefined : resolve(root)
  const chain: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    chain.unshift(dir)
    if (dir === stop) break
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const d of chain) {
    for (const name of PROJECT_FILES) push(join(d, name), 'ancestor-walk')
    push(join(d, '.claude', 'CLAUDE.md'), 'ancestor-walk')
  }

  return out
}
