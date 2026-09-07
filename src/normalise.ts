import type { Event } from './types'

interface Wrapped {
  t?: string
  hook?: string
  raw?: Record<string, unknown> | null
  unparsed?: string
}

/**
 * The lines belonging to the most recent run in a session log.
 *
 * A log is named for the session id, and a resumed session reuses that id, so
 * one file can hold several runs. Worse, a resume can happen in a different
 * directory: entering a worktree does exactly that, and then the earlier run's
 * loads sit in the same file recorded against a different cwd. Reading the
 * whole file attributes those to the current run and classifies them against
 * the wrong root, which is how a project's own CLAUDE.md was once reported
 * FOREIGN (2026-09-07).
 *
 * `record.sh` already runs on SessionStart, so every run opens with one of
 * those lines and the current run is everything from the last one onward. It
 * is ordered before the brief's own hook, so at brief time the marker is
 * present and no loads follow it yet -- which is what makes the brief fall
 * back to prediction instead of claiming to have observed a previous run.
 *
 * A log with no marker at all yields every line, which is the behaviour that
 * predates this function. No session gets worse than it was.
 */
export function currentRun(lines: string[]): string[] {
  let start = 0
  for (const [i, line] of lines.entries()) {
    const text = line.trim()
    if (!text) continue
    try {
      if ((JSON.parse(text) as { hook?: string }).hook === 'SessionStart') start = i
    } catch {
      // A line that will not parse cannot be trusted to mark a boundary.
    }
  }
  return lines.slice(start)
}

/**
 * Turn recorder lines into events.
 *
 * `file_path`, `load_reason` and `memory_type` are the InstructionsLoaded
 * field names, confirmed against a live session on 2026-08-27 (see
 * test/fixtures/payloads/). This function is the only place in the codebase
 * that names them, so if Anthropic renames one, this is a one-place edit.
 */
export function normalise(lines: string[]): Event[] {
  const out: Event[] = []
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue

    let w: Wrapped
    try {
      w = JSON.parse(text) as Wrapped
    } catch {
      out.push({ t: '', ev: 'unparsed', raw: text })
      continue
    }

    const t = typeof w.t === 'string' ? w.t : ''
    const raw = w.raw

    if (!raw || typeof raw !== 'object') {
      // The recorder wraps a payload that wasn't JSON as
      // `{ t, hook: 'unknown', raw: null, unparsed: "<original>" }`. Recover
      // the original text from `unparsed` when it's there; fall back to the
      // whole line only if the shape is something we don't recognise.
      const original = typeof w.unparsed === 'string' ? w.unparsed : text
      out.push({ t, ev: 'unparsed', raw: original })
      continue
    }

    if (w.hook === 'InstructionsLoaded') {
      const path = raw.file_path
      if (typeof path !== 'string') {
        out.push({ t, ev: 'unparsed', raw: text })
        continue
      }
      const reason = typeof raw.load_reason === 'string' ? raw.load_reason : 'unknown'
      const memoryType = typeof raw.memory_type === 'string' ? raw.memory_type : null
      out.push({ t, ev: 'loaded', path, reason, memoryType })
      continue
    }

    if (w.hook === 'ConfigChange') {
      const source = typeof raw.config_source === 'string' ? raw.config_source : 'unknown'
      const keys = Array.isArray(raw.changed_keys)
        ? raw.changed_keys.filter((k): k is string => typeof k === 'string')
        : []
      out.push({ t, ev: 'config', source, keys })
      continue
    }

    out.push({ t, ev: 'unparsed', raw: text })
  }
  return out
}
