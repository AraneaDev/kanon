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

export interface Report {
  root: string
  ruleset: string
  loaded: Classified[]
  missing: Candidate[]
  quiet: Candidate[]
  config: ConfigEvent[]
  modelDisagrees: string[]
}

export const RULESET = '2026-08'

export const DEPENDENCY_SEGMENTS = [
  'node_modules', 'vendor', '.bun', '.venv', 'site-packages', '.cargo', '.gradle', 'Pods',
]
