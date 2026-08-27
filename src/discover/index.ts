import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sessionRoot } from '../origin'
import { DEPENDENCY_SEGMENTS, type Candidate, type SkipReason, type Skipped } from '../types'
import { loadExcludes } from './excludes'
import { resolveImports } from './imports'
import { ruleCandidates } from './rules'
import { walkCandidates } from './walk'

export { loadExcludes }

const SUBDIR_FILES = ['CLAUDE.md', 'CLAUDE.local.md']

/**
 * CLAUDE.md in directories below cwd, excluding cwd itself (cwd's own file is
 * already covered by the ancestor walk). Claude Code discovers on-demand
 * subdirectory files under the current working directory, not under the git
 * root, so a session started in one package of a monorepo must not surface
 * candidates from sibling packages it would never load. Dependency
 * directories and dot-directories are skipped to bound the walk; a load
 * observed inside one is still classified and reported, so skipping them
 * costs no visibility. Directory cycles reachable through symlinks are
 * guarded by device and inode, mirroring rules.ts.
 */
export function subdirCandidates(cwd: string): Candidate[] {
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

  visit(cwd, 0)
  return out
}

export function discover(
  cwd: string,
  homeConfig: string,
): { root: string; candidates: Candidate[]; skipped: Skipped[]; importedBy: Map<string, string> } {
  const root = sessionRoot(cwd)

  // Keyed by path so the same file being flagged more than once (e.g. a
  // missing import target named by two different importers) still lands
  // as one entry in the report rather than a repeated one.
  const skippedByPath = new Map<string, Skipped>()
  const onSkip = (path: string, reason: SkipReason, importer?: string): void => {
    if (!skippedByPath.has(path)) skippedByPath.set(path, importer ? { path, reason, importer } : { path, reason })
  }

  const base = walkCandidates(cwd, homeConfig)
  const rules = ruleCandidates([join(homeConfig, 'rules'), join(root, '.claude', 'rules')], onSkip)
  const subs = subdirCandidates(cwd)

  // claudeMdExcludes is computed up front so it can gate which launch files
  // seed import resolution: an excluded file is never read by Claude Code,
  // so its imports must never be followed. A file imported by a second,
  // non-excluded parent still seeds normally, since only the excluded
  // parent's path is dropped from the seed list, not the imported result.
  const excludes = loadExcludes(root, homeConfig)
  const globs = excludes.map((g) => new Bun.Glob(g))
  const isExcluded = (p: string): boolean => globs.some((g) => g.match(p))

  const launchPaths = [...base, ...rules]
    .filter((c) => c.label === 'launch')
    .map((c) => c.path)
    .filter((p) => !isExcluded(p))
  const imported = resolveImports(launchPaths, 4, onSkip)
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

  // claudeMdExcludes applies last to the full merged set too: a matched
  // candidate is relabelled, not dropped, so the report can explain why it
  // is absent from the load.
  const candidates = [...merged.values()].map((c) =>
    isExcluded(c.path) ? { ...c, label: 'excluded' as const } : c,
  )

  // Returned alongside candidates/skipped, rather than recomputed by the
  // caller: resolveImports deliberately skips its own seeds (launchPaths),
  // so calling it a second time with the merged `launch` candidates -- which
  // already contain every import target -- always finds nothing. cli.ts
  // used to do exactly that, which is why viaImport was always null outside
  // tests that hand-built the map. This is the one real walk of the import
  // graph; there must not be a second.
  return { root, candidates, skipped: [...skippedByPath.values()], importedBy: imported }
}
