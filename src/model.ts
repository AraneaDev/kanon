import { realPath, short } from './paths'
import type { Steered } from './steering'
import { RULESET, type Origin, type Report } from './types'

export const MODEL_VERSION = 1

export interface PaneItem {
  /** As short() spells it: root-relative, ~/..., or absolute. */
  path: string
  /** The realpath, the key `kanon ack` resolves to. */
  real: string
  kind: 'instruction' | 'memory'
  origin: Origin
  /** Load reason when observed, else null. */
  reason: string | null
  verdict: { level: 'gone' | 'may-be-stale'; evidence: string } | null
  acknowledged: boolean
}

export interface PaneModel {
  v: typeof MODEL_VERSION
  root: string
  basis: 'observed' | 'predicted'
  ruleset: string
  /** Loaded (observed) files first, then every other judged item that is not a memory. */
  instructions: PaneItem[]
  memory: PaneItem[]
  injected: Array<{ plugin: string; hookName: string; chars: number }>
  skills: string[]
  compactions: Array<{ t: string; trigger: string; preTokens: number; postTokens: number }>
}

/**
 * The pane's data, from what `report` already computed.
 *
 * Pure on purpose: the report and the pane must never judge differently, so
 * this only arranges a Report and a steering list that cli.ts built with the
 * report's own functions. With no report (an unrecorded session) the model is
 * the prediction, listed from steering alone, and the observed-only fields
 * (injections, skills, compactions) are empty rather than guessed.
 *
 * Realpaths key everything: the steering list is realpathed, a loaded path is
 * resolved here before comparing, and an item the judge did not reach is still
 * listed, with no verdict, because a pane that dropped it would hide a file
 * that steers the session.
 */
export function paneModel(report: Report | null, basis: PaneModel['basis'], root: string, steered: Steered[]): PaneModel {
  const judged = new Map(steered.map((s) => [realPath(s.path), s]))
  const seen = new Set<string>()
  const instructions: PaneItem[] = []
  const memory: PaneItem[] = []

  const item = (path: string, s: Steered | undefined, origin: Origin, reason: string | null): PaneItem => ({
    path: short(path, root),
    real: realPath(path),
    kind: s?.kind ?? 'instruction',
    origin,
    reason,
    verdict: s?.verdict ?? null,
    acknowledged: s?.acknowledged ?? false,
  })
  const place = (it: PaneItem): void => {
    if (seen.has(it.real)) return
    seen.add(it.real)
    ;(it.kind === 'memory' ? memory : instructions).push(it)
  }

  for (const l of report?.loaded ?? []) {
    const s = judged.get(realPath(l.path))
    place(item(l.path, s, l.origin, l.reason))
  }
  for (const s of steered) place(item(s.path, s, s.origin, null))

  return {
    v: MODEL_VERSION,
    root,
    basis,
    ruleset: report?.ruleset ?? RULESET,
    instructions,
    memory,
    injected: (report?.injections ?? []).map((i) => ({ plugin: i.plugin, hookName: i.hookName, chars: i.chars })),
    skills: (report?.skills ?? []).map((s) => s.name),
    compactions: (report?.compactions ?? []).map((c) => ({ t: c.t, trigger: c.trigger, preTokens: c.preTokens, postTokens: c.postTokens })),
  }
}
