import { expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReport } from '../src/report'
import { normalise } from '../src/normalise'
import type { Candidate, Event } from '../src/types'
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
  expect(got).toEqual([
    { t: '2026-08-27T00:00:00Z', ev: 'loaded', path: '/repo/CLAUDE.md', reason: 'session_start', memoryType: null },
  ])
})

test('normalise turns a config change into a config event', () => {
  const raw = JSON.stringify({
    t: '2026-08-27T00:01:00Z',
    hook: 'ConfigChange',
    raw: { hook_event_name: 'ConfigChange', source: 'skills', file_path: '/repo/.claude/skills/a/SKILL.md' },
  })
  expect(normalise([raw])).toEqual([{ t: '2026-08-27T00:01:00Z', ev: 'config', source: 'skills', path: '/repo/.claude/skills/a/SKILL.md' }])
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
  expect(buildReport([], [], ROOT, HOME, new Map()).ruleset).toBe('2026-10')
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

// --- memory_type cross-check -------------------------------------------------
// Claude Code states a file's scope; Kanon infers one. Where the two are
// genuinely incompatible, Kanon is the one that is wrong.

function claimLine(file: string, memoryType: string | null): string {
  const raw: Record<string, unknown> = {
    session_id: 's',
    hook_event_name: 'InstructionsLoaded',
    file_path: file,
    load_reason: 'session_start',
  }
  if (memoryType !== null) raw.memory_type = memoryType
  return JSON.stringify({ t: '2026-08-27T00:00:00Z', hook: 'InstructionsLoaded', raw })
}

function reportFor(file: string, memoryType: string | null, root = ROOT) {
  return buildReport(normalise([claimLine(file, memoryType)]), [], root, '/home/.claude', new Map())
}

test('a memory_type agreeing with the inferred origin raises nothing', () => {
  const r = reportFor('/home/.claude/rules/style.md', 'User')

  expect(r.originDisagrees).toEqual([])
  expect(r.loaded[0]?.origin).toBe('user')
})

test('an incompatible memory_type is recorded as an origin disagreement', () => {
  const r = reportFor('/repo/CLAUDE.md', 'User')

  expect(r.originDisagrees).toEqual([{ path: '/repo/CLAUDE.md', claimed: 'User', inferred: 'project' }])
})

test('Claude Code wins an incompatible claim it states unambiguously', () => {
  const r = reportFor('/repo/CLAUDE.md', 'User')

  expect(r.loaded[0]?.origin).toBe('user')
})

/**
 * The guard that stops this feature crying wolf. Claude Code has no concept
 * of "foreign": a dependency's CLAUDE.md is just another project-scoped file
 * to it. `foreign` is a refinement of `Project`, not a contradiction of it,
 * so the pair must never be reported as a disagreement -- otherwise every
 * genuine FOREIGN find, the highest-value thing Kanon reports, would arrive
 * next to a note calling Kanon's own classification into question.
 */
test('a Project claim does not contradict an inferred foreign origin', () => {
  const r = reportFor('/repo/vendor/p/CLAUDE.md', 'Project')

  expect(r.originDisagrees).toEqual([])
  expect(r.loaded[0]?.origin).toBe('foreign')
})

/**
 * An unrecognised value is not evidence of anything. Only `User` has been
 * seen on a live payload, so the vocabulary is open and an unknown word must
 * never be turned into a claim about Kanon being wrong.
 */
test('an unrecognised memory_type is not treated as a claim', () => {
  const r = reportFor('/repo/vendor/p/CLAUDE.md', 'SomethingNew')

  expect(r.originDisagrees).toEqual([])
  expect(r.loaded[0]?.origin).toBe('foreign')
})

test('a payload with no memory_type is not treated as a claim', () => {
  const r = reportFor('/repo/CLAUDE.md', null)

  expect(r.originDisagrees).toEqual([])
  expect(r.loaded[0]?.origin).toBe('project')
})

/** An origin disagreement says nothing about reachability, so it must not
 * poison the NOT LOADED section the way modelDisagrees does. */
test('an origin disagreement leaves the reachability verdict alone', () => {
  const r = buildReport(
    normalise([claimLine('/repo/CLAUDE.md', 'User')]),
    [{ path: '/repo/CLAUDE.md', label: 'launch', rule: 'ancestor-walk' }],
    ROOT,
    '/home/.claude',
    new Map(),
  )

  expect(r.originDisagrees).toHaveLength(1)
  expect(r.modelDisagrees).toEqual([])
})

/**
 * A file loading twice is ordinary: a compact reload is the usual second.
 * `memory_type` is not guaranteed on any single payload, so tying the claim
 * to the first event would throw away a later one's claim whenever the first
 * carried none, leaving the origin unchecked exactly when Claude Code did
 * state a scope.
 */
test('a memory_type arriving on a later load of the same file is still cross-checked', () => {
  const events: Event[] = [
    { t: '', ev: 'loaded', path: '/repo/CLAUDE.md', reason: 'session_start', memoryType: null },
    { t: '', ev: 'loaded', path: '/repo/CLAUDE.md', reason: 'compact', memoryType: 'User' },
  ]

  const r = buildReport(events, [], '/repo', '/home/x/.claude', new Map())

  expect(r.originDisagrees).toEqual([{ path: '/repo/CLAUDE.md', claimed: 'User', inferred: 'project' }])
  // The claim names exactly one origin, so it wins the column.
  expect(r.loaded[0]?.origin).toBe('user')
  // The reason still comes from the first load, not the reload.
  expect(r.loaded[0]?.reason).toBe('session_start')
})

/** First non-null wins, so a later contradicting claim cannot overwrite one already seen. */
test('the first claim seen survives a later load claiming something else', () => {
  const events: Event[] = [
    { t: '', ev: 'loaded', path: '/repo/CLAUDE.md', reason: 'session_start', memoryType: 'Project' },
    { t: '', ev: 'loaded', path: '/repo/CLAUDE.md', reason: 'compact', memoryType: 'User' },
  ]

  const r = buildReport(events, [], '/repo', '/home/x/.claude', new Map())

  // Project is compatible with the inferred project origin, so nothing is
  // reported; the later User claim must not displace it and invent one.
  expect(r.originDisagrees).toEqual([])
  expect(r.loaded[0]?.origin).toBe('project')
})

test('with no previous digest list the report carries no drift', () => {
  const report = buildReport([], [], '/repo', '/home/.claude', new Map(), [])
  expect(report.drift).toBeNull()
})

/**
 * Fix 2 (whole-branch review): the human report had no gate on `vanished`
 * at all -- render.ts prints report.drift.vanished unconditionally -- so a
 * launch candidate this session simply never triggered (a nested
 * subdir/CLAUDE.md a sibling session visited) printed as "vanished" for a
 * file sitting untouched in the repository. "Vanished" is the word this
 * tool reserves for a rule that was actually deleted.
 *
 * Final review, fix 1: an entry only reaches `absent-unreported` after a
 * commit has already noticed its file is gone, so this now doubles as the
 * "restored between the commit and this read" case -- the exists() recheck
 * that state alone cannot cover, see diff()'s doc comment.
 */
test('a file already recorded absent, but back on disk by the time of this read, is not reported as vanished', () => {
  const dir = tmp('kanon-report-drift-')
  const stillThere = join(dir, 'CLAUDE.md')
  writeFileSync(stillThere, '# still here, just not loaded this session\n')
  const previous = [
    {
      path: stillThere,
      origin: 'project' as const,
      sha256: 'x',
      lastSeen: '2026-08-27T00:00:00Z',
      state: 'absent-unreported' as const,
    },
  ]

  const report = buildReport([], [], dir, '/home/.claude', new Map(), [], previous)

  expect(report.drift?.vanished).toEqual([])
})

test('a file recorded absent and still absent is reported as vanished', () => {
  const dir = tmp('kanon-report-drift-')
  const gone = join(dir, 'CLAUDE.md') // deliberately never created
  const previous = [
    {
      path: gone,
      origin: 'project' as const,
      sha256: 'x',
      lastSeen: '2026-08-27T00:00:00Z',
      state: 'absent-unreported' as const,
    },
  ]

  const report = buildReport([], [], dir, '/home/.claude', new Map(), [], previous)

  expect(report.drift?.vanished.map((f) => f.path)).toEqual([gone])
})

/**
 * Final review, fix 1 again, and the whole point of the three-state field: a
 * file gone from disk whose entry is still `present` -- meaning no commit has
 * noticed the absence yet -- must not be reported as vanished on this read.
 * Reporting it here would be exactly the old bug's shape at the report layer:
 * `merge()` hasn't had the chance to move it to `absent-unreported` yet, so
 * nothing has "recorded" the absence for a reader to have missed.
 */
test('a file gone from disk whose entry is still present is not yet reported as vanished', () => {
  const dir = tmp('kanon-report-drift-')
  const gone = join(dir, 'CLAUDE.md') // deliberately never created
  const previous = [
    { path: gone, origin: 'project' as const, sha256: 'x', lastSeen: '2026-08-27T00:00:00Z', state: 'present' as const },
  ]

  const report = buildReport([], [], dir, '/home/.claude', new Map(), [], previous)

  expect(report.drift?.vanished).toEqual([])
})

test('a transcript load of AGENTS.md is loaded with reason transcript and origin project, not missing', () => {
  const candidates: Candidate[] = [{ path: '/repo/AGENTS.md', label: 'launch', rule: 'ancestor-walk' }]
  const r = buildReport([], candidates, ROOT, HOME, new Map(), [], null, [{ path: '/repo/AGENTS.md', type: 'Project' }])
  expect(r.loaded.map((f) => [f.path, f.reason, f.origin])).toEqual([['/repo/AGENTS.md', 'transcript', 'project']])
  expect(r.missing).toEqual([])
  expect(r.modelDisagrees).toEqual([])
})

test('an AutoMem load of MEMORY.md is loaded as user and never questions the model', () => {
  const memory = '/home/x/.claude/projects/x/memory/MEMORY.md'
  const r = buildReport([], [], ROOT, HOME, new Map(), [], null, [{ path: memory, type: 'AutoMem' }])
  expect(r.loaded.map((f) => [f.path, f.reason, f.origin])).toEqual([[memory, 'transcript', 'user']])
  expect(r.modelDisagrees).toEqual([])
  expect(r.originDisagrees).toEqual([])
})

test('a file in both the events and the transcript appears once, with the event reason', () => {
  const candidates: Candidate[] = [{ path: '/repo/CLAUDE.md', label: 'launch', rule: 'ancestor-walk' }]
  const r = buildReport(normalise([line('/repo/CLAUDE.md')]), candidates, ROOT, HOME, new Map(), [], null, [
    { path: '/repo/CLAUDE.md', type: 'Project' },
  ])
  expect(r.loaded.map((f) => [f.path, f.reason])).toEqual([['/repo/CLAUDE.md', 'session_start']])
})

test('a transcript load the model never predicted still questions the model', () => {
  const r = buildReport([], [], ROOT, HOME, new Map(), [], null, [{ path: '/repo/odd.md', type: 'Project' }])
  expect(r.modelDisagrees).toEqual(['/repo/odd.md'])
})

test('a transcript-only load outside root and homeConfig is not admitted', () => {
  const r = buildReport([], [], ROOT, HOME, new Map(), [], null, [{ path: '/elsewhere/CLAUDE.md', type: 'Project' }])
  expect(r.loaded).toEqual([])
  expect(r.modelDisagrees).toEqual([])
})

test('an event load outside root is still reported, whatever the transcript says', () => {
  const r = buildReport(normalise([line('/elsewhere/CLAUDE.md')]), [], ROOT, HOME, new Map(), [], null, [
    { path: '/elsewhere/CLAUDE.md', type: 'Project' },
  ])
  expect(r.loaded.map((f) => [f.path, f.reason])).toEqual([['/elsewhere/CLAUDE.md', 'session_start']])
})

/**
 * Auto-memory rewrites MEMORY.md as it learns, so a digest of it would read
 * `changed` in nearly every session. It stays out of drift on both sides;
 * AGENTS.md, which arrives the same way, stays in.
 */
test('an AutoMem MEMORY.md is left out of drift, and AGENTS.md is not', () => {
  const dir = tmp('kanon-report-automem-')
  const root = join(dir, 'repo')
  const home = join(dir, 'claude')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(home, 'projects', 'x', 'memory'), { recursive: true })
  const agents = join(root, 'AGENTS.md')
  const memory = join(home, 'projects', 'x', 'memory', 'MEMORY.md')
  writeFileSync(agents, 'new agents\n')
  writeFileSync(memory, 'new memory\n')
  const previous = [
    { path: agents, origin: 'project' as const, sha256: 'old', lastSeen: '2026-08-27T00:00:00Z', state: 'present' as const },
    { path: memory, origin: 'user' as const, sha256: 'old', lastSeen: '2026-08-27T00:00:00Z', state: 'present' as const },
  ]
  const r = buildReport([], [], root, home, new Map(), [], previous, [
    { path: agents, type: 'Project' },
    { path: memory, type: 'AutoMem' },
  ])
  expect(r.drift?.changed.map((f) => f.path)).toEqual([agents])
  expect(r.drift?.appeared).toEqual([])
  expect(r.autoMemory).toEqual([memory])
  expect(r.loaded.map((f) => f.path)).toEqual([agents, memory])
})

/**
 * A ~/.claude/CLAUDE.md symlinked into a dotfiles repository is the common
 * case. Its realpath sits outside the config dir, so classifying the realpath
 * alone called the user's own file FOREIGN, and looking the candidate up by
 * realpath alone missed the prediction and questioned the model as well.
 */
function symlinkedUserFile() {
  const base = tmp('kanon-rep-link-')
  const home = join(base, 'home', '.claude')
  const dotfiles = join(base, 'dotfiles')
  const root = join(base, 'repo')
  mkdirSync(home, { recursive: true })
  mkdirSync(dotfiles, { recursive: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(dotfiles, 'CLAUDE.md'), '# Mine\n')
  symlinkSync(join(dotfiles, 'CLAUDE.md'), join(home, 'CLAUDE.md'))
  const candidates: Candidate[] = [{ path: join(home, 'CLAUDE.md'), label: 'launch', rule: 'user' }]
  return { home, root, path: join(home, 'CLAUDE.md'), candidates }
}

test('a symlinked user CLAUDE.md loaded by event is user, and the model agrees', () => {
  const { home, root, path, candidates } = symlinkedUserFile()
  const r = buildReport(normalise([line(path)]), candidates, root, home, new Map())
  expect(r.loaded.map((l) => l.origin)).toEqual(['user'])
  expect(r.modelDisagrees).toEqual([])
  expect(r.missing).toEqual([])
})

test('a symlinked user CLAUDE.md named only by the transcript is admitted as user', () => {
  const { home, root, path, candidates } = symlinkedUserFile()
  const r = buildReport([], candidates, root, home, new Map(), [], null, [{ path, type: 'User' }])
  expect(r.loaded.map((l) => l.origin)).toEqual(['user'])
  expect(r.modelDisagrees).toEqual([])
})
