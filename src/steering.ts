import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hashFile } from './drift'
import { extractNames } from './names'
import { realPath } from './paths'
import { judge, nameCandidates, type Probe, type Verdict } from './stale'
import type { TranscriptFacts } from './transcript'
import type { Classified, Origin } from './types'

/** One thing that steers a session, with what Kanon judged about it. */
export interface Steered {
  /** Realpathed, so a symlinked memory is found by the path a Read resolves to. */
  path: string
  kind: 'instruction' | 'memory'
  origin: Origin
  digest: string | null
  verdict: Verdict | null
  acknowledged: boolean
}

export interface SteeringInput {
  root: string
  home: string
  /** Observed or predicted instruction files, origin already classified. */
  instructions: Classified[]
  /** `dirname(transcript)/memory`, or null when the transcript is unknown. */
  memoryDir: string | null
  facts: TranscriptFacts
  probe: Probe
  /** When the item was last written: a memory's mtime, an instruction's last commit or mtime. */
  written: (path: string, kind: Steered['kind']) => Date
  read: (path: string) => string | null
  acks: Ack[]
}

/**
 * The user saying "I know, leave it". It holds the digest of the item and of
 * every file it named at that moment, so a change to any of them makes the
 * flag speak again: the claim being waved off is no longer the same claim.
 */
export interface Ack {
  path: string
  digest: string | null
  named: Record<string, string | null>
  t: string
}

/** Claude Code's own word for a MEMORY.md load, as the transcript records it. */
const AUTO_MEMORY = 'AutoMem'

/**
 * The `*.md` files directly in the memory directory, `MEMORY.md` first and
 * the rest by name. A directory that is absent or unreadable has no
 * memories: the transcript may not exist yet, and that is not an error.
 */
function memoryFiles(memoryDir: string | null): string[] {
  if (!memoryDir) return []
  let names: string[]
  try {
    names = readdirSync(memoryDir)
  } catch {
    return []
  }
  const files = names
    .filter((n) => n.endsWith('.md'))
    .filter((n) => {
      try {
        return statSync(join(memoryDir, n)).isFile()
      } catch {
        return false
      }
    })
    .sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a < b ? -1 : a > b ? 1 : 0))
  return files.map((n) => join(memoryDir, n))
}

/**
 * The digest of every file an item names that exists, keyed by the name as
 * written. A name that resolves nowhere is left out, so a file appearing
 * later changes the record as surely as one changing does.
 *
 * Scope is ignored deliberately: a user-level rule's relative names may then
 * clear its ack on an unrelated repo change, which is the safe direction.
 */
export function namedDigests(text: string, itemPath: string, root: string, home: string): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const n of extractNames(text)) {
    if (n.kind !== 'path' || n.text in out) continue
    const hit = nameCandidates(n.text, itemPath, root, home).find((p) => existsSync(p))
    if (hit) out[n.text] = hashFile(hit)
  }
  return out
}

export function acknowledge(item: Steered, named: Record<string, string | null>, now: Date): Ack {
  return { path: item.path, digest: item.digest, named, t: now.toISOString() }
}

function sameRecord(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && a[k] === b[k])
}

/**
 * True while an ack for this path still describes the item and everything
 * it names. An item that could not be read has no digest to match, and is
 * never quiet on the strength of two nulls agreeing.
 */
export function isAcknowledged(item: Steered, acks: Ack[], named: Record<string, string | null>): boolean {
  if (item.digest === null) return false
  return acks.some((a) => a.path === item.path && a.digest === item.digest && sameRecord(a.named, named))
}

interface Entry { path: string; kind: Steered['kind']; origin: Origin }

/**
 * Build one row per thing that steers this session. Must never throw, since
 * it runs inside a hook: a file that cannot be read gets no digest and no
 * verdict, and judge() already turns a failing probe into no verdict.
 */
export function steer(input: SteeringInput): Steered[] {
  const memories = memoryFiles(input.memoryDir)
  // Memory is recognised by realpath, so a MEMORY.md that also arrived as an
  // observed instruction is judged as the memory it is, against the checkout.
  const memoryPaths = new Set(memories.map(realPath))
  for (const l of input.facts.instructions) if (l.type === AUTO_MEMORY) memoryPaths.add(realPath(l.path))

  const entries: Entry[] = []
  const seen = new Set<string>()
  const add = (path: string, kind: Steered['kind'], origin: Origin): void => {
    const real = realPath(path)
    if (seen.has(real)) return
    seen.add(real)
    entries.push({ path: real, kind: memoryPaths.has(real) ? 'memory' : kind, origin })
  }
  for (const c of input.instructions) add(c.path, 'instruction', c.origin)
  // Memory lives under the Claude config dir, so `user` is its only origin.
  for (const l of input.facts.instructions) if (l.type === AUTO_MEMORY) add(l.path, 'memory', 'user')
  for (const m of memories) add(m, 'memory', 'user')

  return entries.map((e) => row(e, input))
}

function row(e: Entry, input: SteeringInput): Steered {
  const out: Steered = { ...e, digest: null, verdict: null, acknowledged: false }
  let text: string | null
  try {
    text = input.read(e.path)
    if (text === null) return out
    out.digest = hashFile(e.path)
  } catch {
    return out
  }
  // Each in its own guard, verdict first: a bad ack or a failing `written`
  // must never cost the other, and a lost verdict is the costlier loss.
  try {
    out.verdict = judge({ ...e, written: input.written(e.path, e.kind), text }, input.root, input.home, input.probe)
  } catch {
    // No verdict is the honest answer to a tooling failure.
  }
  try {
    out.acknowledged = isAcknowledged(out, input.acks, namedDigests(text, e.path, input.root, input.home))
  } catch {
    // Unacknowledged: a flag that speaks again is the safe failure.
  }
  return out
}
