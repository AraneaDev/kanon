import { EMPTY_INVENTORIED, type AgentMemory, type Inventoried, type MarkedHook, type Scope } from './inventory'
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

/**
 * Every injection of one plugin and hook event, collapsed: how many there
 * were, their characters together, and `index`, the position of the most
 * recent one in this run's injections, which is what `kanon show
 * --injection` takes.
 */
export interface InjectedGroup {
  plugin: string
  hookName: string
  count: number
  chars: number
  index: number
}

/**
 * One row per plugin and hook event, the most characters first, ties in
 * order of first sighting. A UserPromptSubmit hook injects on every prompt,
 * and a long session listed each one: 96 rows that were nearly all the same
 * 40 characters, which buried the one injection worth reading. The report's
 * INJECTED section and the pane both group through here, so they cannot
 * count differently.
 */
export function groupInjections(injections: ReadonlyArray<{ plugin: string; hookName: string; chars: number }>): InjectedGroup[] {
  const groups = new Map<string, InjectedGroup>()
  injections.forEach((i, index) => {
    const key = JSON.stringify([i.plugin, i.hookName])
    const g = groups.get(key)
    if (g === undefined) groups.set(key, { plugin: i.plugin, hookName: i.hookName, count: 1, chars: i.chars, index })
    else Object.assign(g, { count: g.count + 1, chars: g.chars + i.chars, index })
  })
  // Array.prototype.sort is stable, so equal totals keep first-sighting order.
  return [...groups.values()].sort((a, b) => b.chars - a.chars)
}

/** A configured hook, or an injection no hook explains (`scope: 'other'`). */
export interface PaneHook {
  scope: Scope
  plugin: string | null
  event: string
  matcher: string | null
  command: string
  injected: MarkedHook['injected']
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
  injected: InjectedGroup[]
  skills: string[]
  compactions: Array<{ t: string; trigger: string; preTokens: number; postTokens: number }>
  /** Every configured hook and every unexplained injection, in scope order. */
  hooks: PaneHook[]
  /** Every skill available, in scope order, invoked ones marked. */
  allSkills: PaneSkill[]
  agentMemory: PaneAgentMemory[]
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
    injected: groupInjections(report?.injections ?? []),
    skills: (report?.skills ?? []).map((s) => s.name),
    compactions: (report?.compactions ?? []).map((c) => ({ t: c.t, trigger: c.trigger, preTokens: c.preTokens, postTokens: c.postTokens })),
    hooks: inv.hooks.map((h) => ({ scope: h.scope, plugin: h.plugin, event: h.event, matcher: h.matcher, command: h.command, injected: h.injected })),
    allSkills: inv.skills.map((s) => ({ scope: s.scope, plugin: s.plugin, name: s.name, path: short(s.path, root), real: realPath(s.path), invoked: s.invoked })),
    agentMemory: inv.agentMemory.map((m) => ({ scope: m.scope, agent: m.agent, path: short(m.path, root), real: realPath(m.path) })),
  }
}
