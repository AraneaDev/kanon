import type { Event } from './types'

interface Wrapped {
  t?: string
  hook?: string
  raw?: Record<string, unknown> | null
  unparsed?: string
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
