import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { tooLarge } from '../limits'
import type { SkipReason } from '../types'

const IMPORT = /([([{]|^|\s)@([^\s`]+)/g

/** Import targets in a file, with code spans and fenced blocks removed first. */
export function parseImports(text: string): string[] {
  const stripped = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')

  const out: string[] = []
  for (const m of stripped.matchAll(IMPORT)) {
    let target = m[2]
    if (target) {
      target = target.replace(/[.,;:!?\)}\]'"]+$/, '')
      if (target) out.push(target)
    }
  }
  return out
}

function resolveTarget(target: string, importer: string): string {
  if (target.startsWith('~/')) return resolve(homedir(), target.slice(2))
  if (isAbsolute(target)) return resolve(target)
  return resolve(dirname(importer), target)
}

/**
 * Walk the import graph breadth-first from the given files. Returns each
 * imported file mapped to the file that imported it. Claude Code allows four
 * hops, so the seed files are depth 0 and depth 4 is the last followed.
 */
export function resolveImports(
  files: string[],
  maxDepth = 4,
  onSkip?: (path: string, reason: SkipReason) => void,
): Map<string, string> {
  const seedSet = new Set<string>(files.map((f) => resolve(f)))
  const found = new Map<string, string>()
  const visited = new Set<string>(seedSet)
  let frontier = Array.from(seedSet)

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const importer of frontier) {
      // Same guard as rules.ts, and for the same reason: an importer over
      // the limit is a file Claude Code itself would skip loading, so
      // treating it as having no @imports (rather than reading it in
      // full to find out) costs no accuracy and bounds the read. Noted,
      // not just skipped, for the same reason as rules.ts.
      if (tooLarge(importer)) {
        onSkip?.(importer, 'too-large')
        continue
      }
      let text = ''
      try {
        text = readFileSync(importer, 'utf8')
      } catch {
        onSkip?.(importer, 'unreadable')
        continue
      }
      for (const target of parseImports(text)) {
        const p = resolveTarget(target, importer)
        if (!existsSync(p)) {
          // The target, not the importer, is what's missing: it's the
          // target's path a reader would want to see and check.
          onSkip?.(p, 'missing-target')
          continue
        }
        if (seedSet.has(p)) continue
        if (!found.has(p)) found.set(p, importer)
        if (visited.has(p)) continue
        visited.add(p)
        next.push(p)
      }
    }
    frontier = next
  }

  return found
}
