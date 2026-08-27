export type Origin = 'managed' | 'user' | 'foreign' | 'local' | 'project'

export type Label = 'launch' | 'on-demand' | 'path-scoped' | 'excluded' | 'unreachable'

export interface Candidate {
  path: string
  label: Label
  rule: string
}

export interface LoadEvent { t: string; ev: 'loaded'; path: string; reason: string }
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
}

export interface Report {
  root: string
  ruleset: string
  loaded: Classified[]
  missing: Candidate[]
  quiet: Candidate[]
  config: ConfigEvent[]
  modelDisagrees: string[]
  skipped: Skipped[]
}

export const RULESET = '2026-08'

export const DEPENDENCY_SEGMENTS = [
  'node_modules', 'vendor', '.bun', '.venv', 'site-packages', '.cargo', '.gradle', 'Pods',
]
