export type Origin = 'managed' | 'user' | 'foreign' | 'local' | 'project'

export type Label = 'launch' | 'on-demand' | 'path-scoped' | 'excluded' | 'unreachable'

export interface Candidate {
  path: string
  label: Label
  rule: string
}

/**
 * `memoryType` is Claude Code's own word for the file's scope, taken from the
 * payload's `memory_type` (confirmed live: the value `User` for a
 * `~/.claude/rules` file). It is a *claim*, where `Origin` is Kanon's
 * *inference*; the two are compared in report.ts. Null when the payload did
 * not carry one, so there is a single shape to reason about.
 */
export interface LoadEvent {
  t: string
  ev: 'loaded'
  path: string
  reason: string
  memoryType: string | null
}
export interface ConfigEvent { t: string; ev: 'config'; source: string; keys: string[] }
export interface UnparsedEvent { t: string; ev: 'unparsed'; raw: string }
export type Event = LoadEvent | ConfigEvent | UnparsedEvent

export interface Classified {
  path: string
  origin: Origin
  reason: string
  viaImport: string | null
  gitIgnored: boolean | null
  gitTracked: boolean | null
}

/**
 * Why a would-be instruction file never became a candidate at all: it was
 * skipped before Kanon could read it (or, for an import target, before it
 * could even be found). Distinct from `missing` in Report, which is a
 * candidate that Kanon *did* form an expectation about but never saw
 * loaded -- a skip never got that far, so without this the report would
 * say nothing about it anywhere.
 */
export type SkipReason = 'too-large' | 'unreadable' | 'missing-target'

export interface Skipped {
  path: string
  reason: SkipReason
  /**
   * For a `missing-target` skip, the file whose @import named it -- a
   * broken import is only actionable if you know where it came from.
   * Absent for `too-large`/`unreadable`, where the skipped path and the
   * file that would have imported it are the same file.
   */
  importer?: string
}

/**
 * Claude Code's stated scope for a file and Kanon's inferred origin, where
 * the two cannot both be right. Recorded separately from `modelDisagrees`:
 * that one is about *reachability*, and a wrong origin says nothing about
 * whether the NOT LOADED section can be trusted.
 */
export interface OriginDisagreement {
  path: string
  claimed: string
  inferred: Origin
}

export interface Report {
  root: string
  ruleset: string
  loaded: Classified[]
  missing: Candidate[]
  quiet: Candidate[]
  config: ConfigEvent[]
  modelDisagrees: string[]
  originDisagrees: OriginDisagreement[]
  skipped: Skipped[]
}

/**
 * Which inferred origins a given `memory_type` does NOT contradict.
 *
 * Deliberately a compatibility table rather than a one-to-one mapping.
 * Claude Code names a broad scope; Kanon draws finer distinctions inside it,
 * and a finer answer is not a wrong one. `foreign` in particular is a
 * refinement of `Project` -- Claude Code has no word for "this project-scoped
 * file was shipped by a dependency" -- so pairing them must never read as a
 * disagreement.
 *
 * Only `User` is confirmed from a live payload (2026-08-27). The rest are
 * the plausible remaining vocabulary, and an unrecognised value is treated
 * as no claim at all rather than as a contradiction, so a value Anthropic
 * adds later degrades to silence instead of a false alarm.
 */
export const CLAIMED_ORIGINS: Record<string, Origin[]> = {
  User: ['user'],
  Managed: ['managed'],
  Policy: ['managed'],
  Enterprise: ['managed'],
  Local: ['local', 'foreign'],
  Project: ['project', 'local', 'foreign'],
}

export const RULESET = '2026-08'

export const DEPENDENCY_SEGMENTS = [
  'node_modules', 'vendor', '.bun', '.venv', 'site-packages', '.cargo', '.gradle', 'Pods',
]
