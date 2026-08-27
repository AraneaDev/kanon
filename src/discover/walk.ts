import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { managedPath } from '../origin'
import type { Candidate } from '../types'

const PROJECT_FILES = ['CLAUDE.md', 'CLAUDE.local.md']

/**
 * Candidates from the fixed scopes: the managed policy file, the user scope,
 * and every directory from the filesystem root down to cwd. Ordered as Claude
 * Code loads them, broadest first.
 */
export function walkCandidates(cwd: string, homeConfig: string): Candidate[] {
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

  // Ancestors, root first so the order matches load order.
  const chain: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    chain.unshift(dir)
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
