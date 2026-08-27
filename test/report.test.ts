import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReport } from '../src/report'
import { normalise } from '../src/normalise'
import type { Candidate } from '../src/types'
import { tmp } from './tmp'

const HOME = '/home/x/.claude'
const ROOT = '/repo'

function line(file: string, reason = 'session_start'): string {
  return JSON.stringify({
    t: '2026-08-27T00:00:00Z',
    hook: 'InstructionsLoaded',
    raw: { session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: file, load_reason: reason },
  })
}

test('normalise turns wrapped payloads into load events', () => {
  const got = normalise([line('/repo/CLAUDE.md')])
  expect(got).toEqual([{ t: '2026-08-27T00:00:00Z', ev: 'loaded', path: '/repo/CLAUDE.md', reason: 'session_start' }])
})

test('normalise turns a config change into a config event', () => {
  const raw = JSON.stringify({
    t: '2026-08-27T00:01:00Z',
    hook: 'ConfigChange',
    raw: { hook_event_name: 'ConfigChange', config_source: 'skills', changed_keys: ['a'] },
  })
  expect(normalise([raw])).toEqual([{ t: '2026-08-27T00:01:00Z', ev: 'config', source: 'skills', keys: ['a'] }])
})

test('normalise keeps an unparseable line rather than dropping it', () => {
  const got = normalise(['{ not json'])
  expect(got[0]?.ev).toBe('unparsed')
})

test('normalise recovers the original text from a recorder-wrapped non-JSON line', () => {
  // This is the actual shape record.sh writes for a payload that wasn't
  // JSON: a valid JSON envelope with raw: null and the original text tucked
  // under `unparsed`. The event's raw field should be the original text,
  // not the whole envelope.
  const wrapped = JSON.stringify({ t: '2026-08-27T00:02:00Z', hook: 'unknown', raw: null, unparsed: 'not json at all' })
  const got = normalise([wrapped])
  expect(got).toEqual([{ t: '2026-08-27T00:02:00Z', ev: 'unparsed', raw: 'not json at all' }])
})

test('a launch candidate that never loaded is missing', () => {
  const candidates: Candidate[] = [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }]
  const r = buildReport([], candidates, ROOT, HOME, new Map())
  expect(r.missing.map((c) => c.path)).toEqual(['/repo/.claude/rules/testing.md'])
})

test('an on-demand candidate that never loaded is quiet, not missing', () => {
  const candidates: Candidate[] = [{ path: '/repo/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' }]
  const r = buildReport([], candidates, ROOT, HOME, new Map())
  expect(r.missing).toEqual([])
  expect(r.quiet.map((c) => c.path)).toEqual(['/repo/docs/CLAUDE.md'])
})

test('a loaded file is classified and carries its reason', () => {
  const candidates: Candidate[] = [{ path: '/repo/CLAUDE.md', label: 'launch', rule: 'ancestor-walk' }]
  const r = buildReport(normalise([line('/repo/CLAUDE.md')]), candidates, ROOT, HOME, new Map())
  expect(r.loaded[0]?.origin).toBe('project')
  expect(r.loaded[0]?.reason).toBe('session_start')
})

test('a load with no matching candidate is recorded as model disagreement AND still classified as loaded', () => {
  // Origin classification needs no prediction, so a candidate-model miss
  // must not blank out layer one: the file still shows up in `loaded` with
  // a real origin. `modelDisagrees` says how much to trust `missing`/`quiet`,
  // it does not gate what actually loaded.
  const r = buildReport(normalise([line('/elsewhere/CLAUDE.md')]), [], ROOT, HOME, new Map())
  expect(r.modelDisagrees).toEqual(['/elsewhere/CLAUDE.md'])
  expect(r.loaded.map((c) => c.path)).toEqual(['/elsewhere/CLAUDE.md'])
  expect(r.loaded[0]?.origin).toBe('foreign')
})

test('a load labelled unreachable is also a model disagreement AND still classified as loaded', () => {
  const candidates: Candidate[] = [{ path: '/repo/odd.md', label: 'unreachable', rule: 'none' }]
  const r = buildReport(normalise([line('/repo/odd.md')]), candidates, ROOT, HOME, new Map())
  expect(r.modelDisagrees).toEqual(['/repo/odd.md'])
  expect(r.loaded.map((c) => c.path)).toEqual(['/repo/odd.md'])
  expect(r.loaded[0]?.origin).toBe('project')
})

test('a vendored CLAUDE.md that the candidate walk never enumerates still lands in loaded, marked foreign', () => {
  // subdirCandidates (Task 6) deliberately skips dependency directories, so
  // a lazily loaded CLAUDE.md under vendor/ or node_modules/ has no matching
  // candidate at all. It must still appear in `loaded` with origin foreign,
  // exactly as the spec's sample report shows for vendor/phpstan/phpstan.
  const vendored = '/repo/vendor/phpstan/phpstan/CLAUDE.md'
  const r = buildReport(normalise([line(vendored)]), [], ROOT, HOME, new Map())
  expect(r.loaded).toHaveLength(1)
  expect(r.loaded[0]?.path).toBe(vendored)
  expect(r.loaded[0]?.origin).toBe('foreign')
})

test('a vendored load is never counted as a model disagreement: it is unenumerated by design, not a model failure', () => {
  // Finding 3: subdirCandidates skips dependency directories on purpose, so
  // a load under one of them never gets a matching candidate. That must not
  // trip modelDisagrees -- doing so would permanently invalidate the NOT
  // LOADED section's reliability note for a reason that isn't a model
  // failure at all.
  const vendored = '/repo/vendor/phpstan/phpstan/CLAUDE.md'
  const r = buildReport(normalise([line(vendored)]), [], ROOT, HOME, new Map())
  expect(r.modelDisagrees).toEqual([])
})

test('a genuine disagreement (an unexpected path with no dependency segment) still trips modelDisagrees', () => {
  const r = buildReport(normalise([line('/elsewhere/CLAUDE.md')]), [], ROOT, HOME, new Map())
  expect(r.modelDisagrees).toEqual(['/elsewhere/CLAUDE.md'])
})

test('an import flag is carried onto the loaded entry', () => {
  const candidates: Candidate[] = [{ path: '/repo/docs/extra.md', label: 'launch', rule: 'import' }]
  const importedBy = new Map([['/repo/docs/extra.md', '/repo/CLAUDE.md']])
  const r = buildReport(normalise([line('/repo/docs/extra.md')]), candidates, ROOT, HOME, importedBy)
  expect(r.loaded[0]?.viaImport).toBe('/repo/CLAUDE.md')
})

test('the ruleset version is stamped on every report', () => {
  expect(buildReport([], [], ROOT, HOME, new Map()).ruleset).toBe('2026-08')
})

test('the same file loaded twice appears once, keeping the first reason seen', () => {
  const candidates: Candidate[] = [{ path: '/repo/CLAUDE.md', label: 'launch', rule: 'ancestor-walk' }]
  const events = normalise([line('/repo/CLAUDE.md'), line('/repo/CLAUDE.md', 'compact')])
  const loaded = buildReport(events, candidates, ROOT, HOME, new Map()).loaded
  expect(loaded.length).toBe(1)
  expect(loaded[0]?.reason).toBe('session_start')
})

test('gitIgnored and gitTracked stay null for a non-foreign origin', () => {
  const candidates: Candidate[] = [{ path: '/repo/CLAUDE.md', label: 'launch', rule: 'ancestor-walk' }]
  const r = buildReport(normalise([line('/repo/CLAUDE.md')]), candidates, ROOT, HOME, new Map())
  expect(r.loaded[0]?.gitIgnored).toBeNull()
  expect(r.loaded[0]?.gitTracked).toBeNull()
})

test('gitIgnored and gitTracked reflect real git state for a foreign load', () => {
  const dir = mktempGitRepo()
  const root = join(dir, 'repo')
  const foreign = join(root, 'node_modules', 'pkg', 'CLAUDE.md')
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(foreign, '')
  const candidates: Candidate[] = [{ path: foreign, label: 'launch', rule: 'import' }]
  const r = buildReport(normalise([line(foreign)]), candidates, root, HOME, new Map())
  expect(r.loaded[0]?.origin).toBe('foreign')
  // Untracked and not covered by any .gitignore: git can answer definitely,
  // so both flags should come back a confident false, not null.
  expect(r.loaded[0]?.gitIgnored).toBe(false)
  expect(r.loaded[0]?.gitTracked).toBe(false)
})

test('gitIgnored and gitTracked are null, not a false "no", when git cannot answer at all', () => {
  // A path entirely outside the repository working tree makes both git
  // plumbing commands exit fatally (128), which must not be read as "no".
  const dir = mktempGitRepo()
  const root = join(dir, 'repo')
  const outside = join(dir, 'outside.md')
  writeFileSync(outside, '')
  const candidates: Candidate[] = [{ path: outside, label: 'launch', rule: 'import' }]
  const r = buildReport(normalise([line(outside)]), candidates, root, HOME, new Map())
  expect(r.loaded[0]?.origin).toBe('foreign')
  expect(r.loaded[0]?.gitIgnored).toBeNull()
  expect(r.loaded[0]?.gitTracked).toBeNull()
})

test('gitIgnored is null rather than false when root is not a git repository at all', () => {
  const dir = tmp('kanon-r-')
  const foreign = join(dir, 'node_modules', 'pkg', 'CLAUDE.md')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(foreign, '')
  const candidates: Candidate[] = [{ path: foreign, label: 'launch', rule: 'import' }]
  const r = buildReport(normalise([line(foreign)]), candidates, dir, HOME, new Map())
  expect(r.loaded[0]?.origin).toBe('foreign')
  expect(r.loaded[0]?.gitIgnored).toBeNull()
  expect(r.loaded[0]?.gitTracked).toBeNull()
})

function mktempGitRepo(): string {
  const dir = tmp('kanon-r-')
  mkdirSync(join(dir, 'repo'))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: join(dir, 'repo') })
  return dir
}
