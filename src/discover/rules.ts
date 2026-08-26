import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Candidate } from '../types'

/** True when the file opens with YAML frontmatter carrying a paths key. */
export function isPathScoped(text: string): boolean {
  if (!text.startsWith('---')) return false
  const end = text.indexOf('\n---', 3)
  if (end === -1) return false
  return /^paths\s*:/m.test(text.slice(3, end))
}

/**
 * Every .md under each rules directory, recursively, following symlinks.
 * Cycles are guarded by device and inode, so a directory is visited once.
 */
export function ruleCandidates(roots: string[]): Candidate[] {
  const out: Candidate[] = []
  const seenDirs = new Set<string>()
  const seenFiles = new Set<string>()

  const visit = (dir: string): void => {
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
      const full = join(dir, name)
      let est
      try {
        est = statSync(full)
      } catch {
        continue
      }
      if (est.isDirectory()) {
        visit(full)
        continue
      }
      if (!name.endsWith('.md')) continue
      const p = resolve(full)
      if (seenFiles.has(p)) continue
      seenFiles.add(p)

      let text = ''
      try {
        text = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      out.push({
        path: p,
        label: isPathScoped(text) ? 'path-scoped' : 'launch',
        rule: 'rules-dir',
      })
    }
  }

  for (const r of roots) visit(r)
  return out
}
