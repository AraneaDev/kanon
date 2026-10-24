import { isAbsolute } from 'node:path'
import { EMPTY_INVENTORIED, type AgentMemory, type Inventoried, type MarkedHook, type Scope } from './inventory'
import { realPath, short, shortCommand } from './paths'
import type { Steered } from './steering'
import { RULESET, type Origin, type Report } from './types'

/**
 * 2: `hooks`, `skills` as rows and `agentMemory` replace `injected` and the
 * list of invoked skill names (the full inventory, 2026-10-24).
 */
export const MODEL_VERSION = 2

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

/**
 * A configured hook, or an injection no hook explains (`scope: 'other'`).
 * `injected` collapses every injection it made this run: how many, their
 * characters together, and `index`, the position of the most recent in this
 * run's injections, which is what `kanon show --injection` takes. A
 * UserPromptSubmit hook injects on every prompt, and a long session once
 * listed 96 rows that were nearly all the same 40 characters.
 */
export interface PaneHook {
  scope: Scope
  plugin: string | null
  event: string
  matcher: string | null
  /** As shortCommand() writes it. */
  command: string
  /** The file it was configured in, as short() spells it; empty for `other`. */
  source: string
  injected: MarkedHook['injected']
  /** An injection may be this hook's, but another plugin's hook runs the same command (MarkedHook). */
  shared: boolean
}

export interface PaneSkill {
  scope: Scope
  plugin: string | null
  name: string
  /** As short() spells it. */
  path: string
  real: string
  invoked: boolean
}

export interface PaneAgentMemory {
  scope: AgentMemory['scope']
  agent: string
  path: string
  real: string
}

export interface PaneModel {
  v: typeof MODEL_VERSION
  root: string
  basis: 'observed' | 'predicted'
  ruleset: string
  /** Loaded (observed) files first, then every other judged item that is not a memory. */
  instructions: PaneItem[]
  memory: PaneItem[]
  /** Every configured hook and every unexplained injection, in scope order. */
  hooks: PaneHook[]
  /** Every skill available, in scope order, invoked ones marked. */
  skills: PaneSkill[]
  agentMemory: PaneAgentMemory[]
  compactions: Array<{ t: string; trigger: string; preTokens: number; postTokens: number }>
}

/**
 * The pane's data, from what `report` already computed.
 *
 * Pure on purpose: the report and the pane must never judge differently, so
 * this only arranges a Report and a steering list that cli.ts built with the
 * report's own functions. With no report (an unrecorded session) the model is
 * the prediction, listed from steering alone, and what only a run can say
 * (injection and invoked marks, compactions) is empty rather than guessed.
 * The inventory itself is read from disk, so it is listed on either basis.
 *
 * Realpaths key everything: the steering list is realpathed, a loaded path is
 * resolved here before comparing, and an item the judge did not reach is still
 * listed, with no verdict, because a pane that dropped it would hide a file
 * that steers the session.
 */
export function paneModel(report: Report | null, basis: PaneModel['basis'], root: string, steered: Steered[], inv: Inventoried = EMPTY_INVENTORIED): PaneModel {
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
    hooks: inv.hooks.map((h) => ({
      scope: h.scope,
      plugin: h.plugin,
      event: h.event,
      matcher: h.matcher,
      command: shortCommand(h.command, root),
      source: h.source === '' ? '' : short(h.source, root),
      injected: h.injected,
      shared: h.shared,
    })),
    // A transcript can name a skill by a path that is no file (`plugin:x:y`); such a row has nothing to open.
    skills: inv.skills.map((s) => {
      const file = isAbsolute(s.path)
      return { scope: s.scope, plugin: s.plugin, name: s.name, path: file ? short(s.path, root) : '', real: file ? realPath(s.path) : '', invoked: s.invoked }
    }),
    agentMemory: inv.agentMemory.map((m) => ({ scope: m.scope, agent: m.agent, path: short(m.path, root), real: realPath(m.path) })),
    compactions: (report?.compactions ?? []).map((c) => ({ t: c.t, trigger: c.trigger, preTokens: c.preTokens, postTokens: c.postTokens })),
  }
}
