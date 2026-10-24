import { cleanLine } from './normalise'

/**
 * What Kanon reads out of a Claude Code session transcript
 * (`~/.claude/projects/<project>/<session>.jsonl`).
 *
 * This is the only file that names transcript fields (`attachment`,
 * `hook_additional_context`, `compactMetadata`, ...). The transcript is
 * Claude Code's own log, not a documented interface, so every access here is
 * defensive: a renamed or reshaped field degrades to an empty list, never a
 * throw. A hook must never fail a session, and this runs inside them.
 */

/** One string a hook injected into context, and the command believed to have printed it. */
export interface Injection { hookName: string; chars: number; command: string | null }

export interface TranscriptFacts {
  /** Every instruction file the session loaded, first sighting of each path. */
  instructions: Array<{ path: string; type: string }>
  injections: Injection[]
  skills: Array<{ name: string; path: string }>
  compactions: Array<{ t: string; trigger: string; preTokens: number; postTokens: number }>
  /** Reads of a `memory/*.md` file by the assistant. */
  reads: Array<{ t: string; path: string }>
}

export const EMPTY_FACTS: TranscriptFacts = {
  instructions: [],
  injections: [],
  skills: [],
  compactions: [],
  reads: [],
}

/** How much of an injection is compared against hook stdout. */
const PROBE = 200

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

interface Pending { hookName: string; text: string }
interface HookRun { hookName: string; command: string; stdout: string }

/**
 * A hook's stdout is usually JSON, so the injection it carried sits inside it
 * with newlines and quotes escaped, while a plain-text hook prints it as is.
 * Either spelling counts as the same text.
 */
function carries(stdout: string, probe: string): boolean {
  return stdout.includes(probe) || stdout.includes(JSON.stringify(probe).slice(1, -1))
}

/** `SessionStart` owns `SessionStart:clear`, and nothing else owns it. */
function sameEvent(injected: string, ran: string): boolean {
  return ran === injected || ran.startsWith(`${injected}:`)
}

function commandFor(p: Pending, runs: HookRun[]): string | null {
  const probe = p.text.slice(0, PROBE)
  if (!probe) return null
  return runs.find((r) => sameEvent(p.hookName, r.hookName) && carries(r.stdout, probe))?.command ?? null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Whether `text`, a stretch of transcript, reaches back before `since`: its
 * first record with a parseable timestamp is older. Records are appended in
 * time order, so that record is the oldest in the stretch, and once it
 * predates the run everything the run wrote lies after it. A fragment or a
 * record with no timestamp is passed over; a stretch with none to judge by
 * does not reach back, so reading goes on.
 */
export function reachesBefore(text: string, since: Date): boolean {
  const floor = since.getTime()
  for (const line of text.split('\n')) {
    const clean = cleanLine(line)
    if (!clean) continue
    let at: number
    try {
      at = Date.parse(str(obj(JSON.parse(clean))?.timestamp) ?? '')
    } catch {
      continue
    }
    if (Number.isFinite(at)) return at < floor
  }
  return false
}

/**
 * `since` scopes the facts to one run. A transcript outlives a run: resume,
 * clear and compact all append to the same file, from whatever directory the
 * session is in by then, so without it an earlier run's loads in another root
 * would be attributed to this one. A record with no parseable timestamp
 * cannot be placed on either side of the boundary and is dropped.
 */
export function readTranscript(text: string, since: Date | null = null): TranscriptFacts {
  return scan(text, since).facts
}

/**
 * The text of each injection of the run, in the order and at the positions
 * `readTranscript().injections` lists them, so the index the pane shows for
 * an injection is the index `kanon show --injection` reads back. Kept out of
 * the facts: every report would otherwise carry every injection's text, and
 * only `show` ever needs one.
 */
export function injectionTexts(text: string, since: Date | null = null): string[] {
  return scan(text, since).pending.map((p) => p.text)
}

function scan(text: string, since: Date | null): { facts: TranscriptFacts; pending: Pending[] } {
  const floor = since === null ? null : since.getTime()
  const seen = new Set<string>()
  const pending: Pending[] = []
  const runs: HookRun[] = []
  const facts: TranscriptFacts = { instructions: [], injections: [], skills: [], compactions: [], reads: [] }

  for (const line of text.split('\n')) {
    const clean = cleanLine(line)
    if (!clean) continue
    let rec: Obj | null
    try {
      rec = obj(JSON.parse(clean))
    } catch {
      continue
    }
    if (!rec) continue
    const t = str(rec.timestamp) ?? ''
    if (floor !== null) {
      const at = Date.parse(t)
      if (!Number.isFinite(at) || at < floor) continue
    }

    const att = obj(rec.attachment)
    if (att) {
      switch (att.type) {
        case 'instructions':
          for (const f of arr(att.files)) {
            const file = obj(f)
            const path = str(file?.path)
            if (!file || !path || seen.has(path)) continue
            seen.add(path)
            facts.instructions.push({ path, type: str(file.type) ?? '' })
          }
          break
        case 'hook_additional_context': {
          const hookName = str(att.hookName) ?? ''
          for (const c of arr(att.content)) if (typeof c === 'string') pending.push({ hookName, text: c })
          break
        }
        case 'hook_success': {
          const hookName = str(att.hookName)
          const stdout = str(att.stdout)
          if (hookName && stdout) runs.push({ hookName, command: str(att.command) ?? '', stdout })
          break
        }
        case 'invoked_skills':
          for (const s of arr(att.skills)) {
            const skill = obj(s)
            const name = str(skill?.name)
            if (name) facts.skills.push({ name, path: str(skill?.path) ?? '' })
          }
          break
      }
      continue
    }

    if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
      const m = obj(rec.compactMetadata)
      if (m) {
        facts.compactions.push({
          t,
          trigger: str(m.trigger) ?? '',
          preTokens: num(m.preTokens),
          postTokens: num(m.postTokens),
        })
      }
      continue
    }

    if (rec.type === 'assistant') {
      for (const c of arr(obj(rec.message)?.content)) {
        const block = obj(c)
        if (block?.type !== 'tool_use' || block.name !== 'Read') continue
        const path = str(obj(block.input)?.file_path)
        if (path && /(^|\/)memory\/[^/]+\.md$/.test(path)) facts.reads.push({ t, path })
      }
    }
  }

  facts.injections = pending.map((p) => ({
    hookName: p.hookName,
    chars: p.text.length,
    command: commandFor(p, runs),
  }))
  return { facts, pending }
}
