import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sessionRoot } from '../origin'
import { DEPENDENCY_SEGMENTS, type Candidate } from '../types'
import { loadExcludes } from './excludes'
import { resolveImports } from './imports'
import { ruleCandidates } from './rules'
import { walkCandidates } from './walk'

export { loadExcludes }

const SUBDIR_FILES = ['CLAUDE.md', 'CLAUDE.local.md']

/**
 * CLAUDE.md in directories below the project root, excluding the root itself
 * (the root's own file is already covered by the ancestor walk). Dependency
 * directories and dot-directories are skipped to bound the walk; a load
 * observed inside one is still classified and reported, so skipping them
 * costs no visibility. Directory cycles reachable through symlinks are
 * guarded by device and inode, mirroring rules.ts.
 */
function subdirCandidates(root: string): Candidate[] {
  const out: Candidate[] = []
  const seenDirs = new Set<string>()

  const visit = (dir: string, depth: number): void => {
    if (depth > 8) return
    let st
    try {
      st = statSync(dir)
    } catch {
      return
    }
    const key = `${st.dev}:${st.ino}`
    if (seenDirs.has(key)) return
    seenDirs.add(key)

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const name of entries) {
      if (DEPENDENCY_SEGMENTS.includes(name)) continue
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let est
      try {
        est = statSync(full)
      } catch {
        continue
      }
      if (est.isDirectory()) {
        visit(full, depth + 1)
      } else if (depth > 0 && SUBDIR_FILES.includes(name)) {
        out.push({ path: resolve(full), label: 'on-demand', rule: 'subdirectory' })
      }
    }
  }

  visit(root, 0)
  return out
}

export function discover(cwd: string, homeConfig: string): { root: string; candidates: Candidate[] } {
  const root = sessionRoot(cwd)

  const base = walkCandidates(cwd, homeConfig)
  const rules = ruleCandidates([join(homeConfig, 'rules'), join(root, '.claude', 'rules')])
  const subs = subdirCandidates(root)

  const launchPaths = [...base, ...rules].filter((c) => c.label === 'launch').map((c) => c.path)
  const imported = resolveImports(launchPaths)
  const importCandidates: Candidate[] = [...imported.keys()].map((p) => ({
    path: p,
    label: 'launch',
    rule: 'import',
  }))

  // Earlier sources win on overlap: an explicit import of a subdirectory
  // CLAUDE.md means it loads at launch, not merely on demand.
  const merged = new Map<string, Candidate>()
  for (const c of [...base, ...rules, ...importCandidates, ...subs]) {
    if (!merged.has(c.path)) merged.set(c.path, c)
  }

  // claudeMdExcludes applies last: a matched candidate is relabelled, not
  // dropped, so the report can explain why it is absent from the load.
  const excludes = loadExcludes(root, homeConfig)
  const globs = excludes.map((g) => new Bun.Glob(g))
  const candidates = [...merged.values()].map((c) =>
    globs.some((g) => g.match(c.path)) ? { ...c, label: 'excluded' as const } : c,
  )

  return { root, candidates }
}
