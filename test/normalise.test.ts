import { expect, test } from 'bun:test'
import { compactions, currentRun, normalise, transcriptOf } from '../src/normalise'

/**
 * memory_type is Claude Code's own statement of a file's scope, confirmed
 * present on a live InstructionsLoaded payload alongside file_path and
 * load_reason. Kanon uses it to cross-check its inferred origin, so the
 * normaliser has to carry it through rather than drop it.
 */
test('a loaded event carries memory_type when the payload has one', () => {
  const line = JSON.stringify({
    t: '2026-08-27T08:59:14Z',
    hook: 'InstructionsLoaded',
    raw: { file_path: '/root/.claude/rules/style.md', load_reason: 'session_start', memory_type: 'User' },
  })

  const [e] = normalise([line])

  expect(e).toEqual({
    t: '2026-08-27T08:59:14Z',
    ev: 'loaded',
    path: '/root/.claude/rules/style.md',
    reason: 'session_start',
    memoryType: 'User',
  })
})

/**
 * The field is not guaranteed. A payload without it must still normalise,
 * with memoryType null rather than absent, so the cross-check has one shape
 * to test against instead of two.
 */
test('a loaded event without memory_type gets a null memoryType', () => {
  const line = JSON.stringify({
    t: '2026-08-27T08:59:14Z',
    hook: 'InstructionsLoaded',
    raw: { file_path: '/a/CLAUDE.md', load_reason: 'session_start' },
  })

  const [e] = normalise([line])

  expect(e).toMatchObject({ ev: 'loaded', memoryType: null })
})

/** A non-string memory_type is not a claim about anything. */
test('a non-string memory_type is discarded', () => {
  const line = JSON.stringify({
    t: '',
    hook: 'InstructionsLoaded',
    raw: { file_path: '/a/CLAUDE.md', load_reason: 'session_start', memory_type: 7 },
  })

  const [e] = normalise([line])

  expect(e).toMatchObject({ ev: 'loaded', memoryType: null })
})

/**
 * The whole normaliser rests on three field names Kanon does not own. This
 * test reads a payload captured verbatim from a live Claude Code session
 * (2026-08-27) rather than one hand-written to match the code, so if
 * Anthropic renames a field the fixture can be re-captured and this test
 * fails honestly instead of agreeing with a stale assumption.
 */
test('the payload captured from a live session normalises to a load event', async () => {
  const raw = await Bun.file(new URL('./fixtures/payloads/instructions-loaded.json', import.meta.url)).json()

  const [e] = normalise([JSON.stringify({ t: '2026-08-27T08:59:14Z', hook: 'InstructionsLoaded', raw })])

  expect(e).toEqual({
    t: '2026-08-27T08:59:14Z',
    ev: 'loaded',
    path: '/home/user/.claude/rules/style.md',
    reason: 'session_start',
    memoryType: 'User',
  })
})

/**
 * file_path is the one field the whole load record hangs on. A payload
 * carrying no usable one names no file, so it must not become a load event
 * that claims to: it stays unparsed, where the raw line is still readable in
 * the report, rather than being dropped or turned into a load of "undefined".
 */
test('an InstructionsLoaded payload with no usable file_path stays unparsed', () => {
  const line = JSON.stringify({
    t: '2026-08-27T08:59:14Z',
    hook: 'InstructionsLoaded',
    raw: { file_path: 42, load_reason: 'session_start' },
  })

  const [e] = normalise([line])

  expect(e).toEqual({ t: '2026-08-27T08:59:14Z', ev: 'unparsed', raw: line })
})

/**
 * The recorder writes down every hook it is bound to, and Kanon models two
 * of them. A third -- one Anthropic adds, or one a user binds the recorder
 * to -- must survive to the report as unparsed rather than vanishing, since
 * the raw line is the only evidence there is that it happened at all.
 */
test('a payload from a hook Kanon does not model stays unparsed rather than being dropped', () => {
  const line = JSON.stringify({
    t: '2026-08-27T08:59:14Z',
    hook: 'SomethingAnthropicAddedLater',
    raw: { session_id: 's', hook_event_name: 'SomethingAnthropicAddedLater' },
  })

  const [e] = normalise([line])

  expect(e).toEqual({ t: '2026-08-27T08:59:14Z', ev: 'unparsed', raw: line })
})

/** An absent timestamp is an empty one, so every event has the same shape. */
test('a payload with no timestamp normalises with an empty one, not undefined', () => {
  const line = JSON.stringify({ hook: 'InstructionsLoaded', raw: { file_path: '/a/CLAUDE.md' } })

  const [e] = normalise([line])

  expect(e).toEqual({ t: '', ev: 'loaded', path: '/a/CLAUDE.md', reason: 'unknown', memoryType: null })
})

/**
 * ConfigChange carries `source` and an optional `file_path`, confirmed on
 * live payloads on 2026-10-23. Kanon had read `config_source` and
 * `changed_keys` from the documentation, neither of which Claude Code sends,
 * so every config row printed `unknown  (+0)` until the fixture was captured.
 */
test('a live ConfigChange payload yields its source and file path', async () => {
  const raw = await Bun.file(new URL('./fixtures/payloads/config-change.json', import.meta.url)).json()

  const [e] = normalise([JSON.stringify({ t: '2026-10-02T21:07:00Z', hook: 'ConfigChange', raw })])

  expect(e).toEqual({
    t: '2026-10-02T21:07:00Z',
    ev: 'config',
    source: 'skills',
    path: '/home/user/example/.claude/skills/example-skill/SKILL.md',
  })
})

test('a ConfigChange with no file_path yields a null path', () => {
  const line = JSON.stringify({ t: '2026-10-02T21:07:00Z', hook: 'ConfigChange', raw: { source: 'user_settings' } })

  const [e] = normalise([line])

  expect(e).toEqual({ t: '2026-10-02T21:07:00Z', ev: 'config', source: 'user_settings', path: null })
})

/**
 * A source Kanon cannot read is reported as `unknown` rather than guessed
 * at, which is what makes a renamed field show up as a visibly useless row
 * instead of a confident wrong one. The old documented name is not a
 * fallback: it never existed on a live payload.
 */
test('a ConfigChange with no usable source is reported as unknown, never guessed', () => {
  const line = JSON.stringify({ t: '2026-10-02T21:07:00Z', hook: 'ConfigChange', raw: { source: 7, config_source: 'skills' } })

  const [e] = normalise([line])

  expect(e).toMatchObject({ ev: 'config', source: 'unknown' })
})

/**
 * An unclean shutdown (seen under WSL) can zero-fill the tail of an appended
 * block, so a log line arrives prefixed with NUL bytes that record.sh never
 * wrote. `trim()` does not remove `\0`, so such a line used to read as
 * unparsed, and a damaged SessionStart stopped marking the start of its run.
 */
const nulSessionStart =
  '\u0000'.repeat(1053) + JSON.stringify({ t: '2026-09-02T13:46:45Z', hook: 'SessionStart', raw: { session_id: 's' } })

test('a line prefixed with NUL bytes still parses', () => {
  const line =
    '\u0000'.repeat(1053) +
    JSON.stringify({ t: '2026-09-02T13:46:45Z', hook: 'InstructionsLoaded', raw: { file_path: '/a/CLAUDE.md', load_reason: 'session_start' } })

  expect(normalise([line])).toEqual([
    { t: '2026-09-02T13:46:45Z', ev: 'loaded', path: '/a/CLAUDE.md', reason: 'session_start', memoryType: null },
  ])
})

test('a NUL-prefixed SessionStart still marks the start of a run', () => {
  const loaded = (path: string) =>
    JSON.stringify({ t: '2026-09-02T13:46:00Z', hook: 'InstructionsLoaded', raw: { file_path: path, load_reason: 'session_start' } })
  const lines = [loaded('/a/CLAUDE.md'), nulSessionStart, loaded('/b/CLAUDE.md')]

  expect(currentRun(lines)).toEqual(lines.slice(1))
})

test('NULs inside a truncated line leave it unparsed, never thrown', () => {
  const events = normalise(['{"t":"x","hook":"Instr\u0000\u0000'])

  expect(events).toHaveLength(1)
  expect(events[0]!.ev).toBe('unparsed')
})

/**
 * A zero-fill overwrites bytes rather than inserting them. NULs inside a
 * line may stand where characters were, so removing them could turn
 * "/repo/CLAUDE.md" into "/reCLAUDE.md": a path outside the root, read as
 * FOREIGN. Only the padding at the edges of a line is stripped.
 */
test('NULs that replaced characters inside a line leave it unparsed', () => {
  const line = JSON.stringify({ t: 'x', hook: 'InstructionsLoaded', raw: { file_path: '/repo/CLAUDE.md', load_reason: 'session_start' } })
    .replace('po/', '\u0000\u0000\u0000')

  expect(normalise([line]).map((e) => e.ev)).toEqual(['unparsed'])
})

const start = (raw: Record<string, unknown>) =>
  JSON.stringify({ t: '2026-10-24T10:00:00Z', hook: 'SessionStart', raw })

test('a SessionStart payload yields a start event with its source and transcript', () => {
  const [e] = normalise([start({ source: 'compact', transcript_path: '/t/x.jsonl' })])
  expect(e).toEqual({ t: '2026-10-24T10:00:00Z', ev: 'start', source: 'compact', transcript: '/t/x.jsonl' })
})

test('a SessionStart without source is unknown', () => {
  const [e] = normalise([start({})])
  expect(e).toEqual({ t: '2026-10-24T10:00:00Z', ev: 'start', source: 'unknown', transcript: null })
})

test('compactions counts compact starts only', () => {
  const events = normalise(['startup', 'compact', 'resume', 'compact'].map((source) => start({ source })))
  expect(compactions(events)).toBe(2)
})

test('transcriptOf takes the last start event that names one', () => {
  const events = normalise([
    start({ source: 'startup', transcript_path: '/t/a.jsonl' }),
    start({ source: 'resume', transcript_path: '/t/b.jsonl' }),
    start({ source: 'compact' }),
  ])
  expect(transcriptOf(events)).toBe('/t/b.jsonl')
  expect(transcriptOf([])).toBeNull()
})
