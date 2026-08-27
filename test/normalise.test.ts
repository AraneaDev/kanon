import { expect, test } from 'bun:test'
import { normalise } from '../src/normalise'

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
    path: '/root/.claude/rules/schrijfstijl.md',
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
 * ConfigChange's field names are the ones Kanon has never seen on a live
 * payload (see the README's status note). Each is therefore read
 * defensively: a source it cannot read is reported as `unknown` rather than
 * guessed at, which is what makes a renamed field show up as a visibly
 * useless row instead of a confident wrong one.
 */
test('a ConfigChange with no usable config_source is reported as unknown, never guessed', () => {
  const line = JSON.stringify({
    t: '2026-08-27T06:58:00Z',
    hook: 'ConfigChange',
    raw: { config_source: null, changed_keys: ['skills'] },
  })

  const [e] = normalise([line])

  expect(e).toEqual({ t: '2026-08-27T06:58:00Z', ev: 'config', source: 'unknown', keys: ['skills'] })
})

test('a ConfigChange whose changed_keys is not a list yields no keys rather than throwing', () => {
  const line = JSON.stringify({
    t: '2026-08-27T06:58:00Z',
    hook: 'ConfigChange',
    raw: { config_source: 'skills', changed_keys: 'skills' },
  })

  const [e] = normalise([line])

  expect(e).toMatchObject({ ev: 'config', source: 'skills', keys: [] })
})

test('non-string entries in changed_keys are dropped and the string ones kept', () => {
  const line = JSON.stringify({
    t: '2026-08-27T06:58:00Z',
    hook: 'ConfigChange',
    raw: { config_source: 'settings', changed_keys: ['a', 7, null, 'b'] },
  })

  const [e] = normalise([line])

  expect(e).toMatchObject({ ev: 'config', keys: ['a', 'b'] })
})
