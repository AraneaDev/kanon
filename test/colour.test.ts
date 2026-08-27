import { expect, test } from 'bun:test'
import { COLOUR, PLAIN, colourEnabled, paintFor } from '../src/colour'
import { render } from '../src/render'
import type { Report } from '../src/types'

function base(): Report {
  return {
    root: '/repo',
    ruleset: '2026-08',
    loaded: [],
    missing: [],
    quiet: [],
    config: [],
    modelDisagrees: [],
    originDisagrees: [],
    skipped: [],
  }
}

const ESC = '\x1b'

// --- when colour is allowed at all -------------------------------------------

test('an interactive terminal gets colour', () => {
  expect(colourEnabled({}, true)).toBe(true)
})

/**
 * The case that matters most. `/kanon` runs the CLI through Claude Code's
 * Bash tool, so stdout is a pipe and the report is on its way into a model's
 * context. Escape codes there cost tokens and come back out as literal text.
 */
test('a pipe gets no colour, which is the /kanon path', () => {
  expect(colourEnabled({}, false)).toBe(false)
})

test('NO_COLOR turns colour off on a terminal', () => {
  expect(colourEnabled({ NO_COLOR: '1' }, true)).toBe(false)
})

/** Per no-color.org the variable counts only when it is present and non-empty. */
test('an empty NO_COLOR is not a request for no colour', () => {
  expect(colourEnabled({ NO_COLOR: '' }, true)).toBe(true)
})

test('FORCE_COLOR turns colour on without a terminal', () => {
  expect(colourEnabled({ FORCE_COLOR: '1' }, false)).toBe(true)
})

test('FORCE_COLOR=0 turns colour off on a terminal', () => {
  expect(colourEnabled({ FORCE_COLOR: '0' }, true)).toBe(false)
})

/**
 * An explicit off beats an explicit on. A user who has switched colour off
 * system-wide should never have it forced back on by an inherited variable
 * they did not set themselves.
 */
test('NO_COLOR beats FORCE_COLOR', () => {
  expect(colourEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false)
})

test('a dumb terminal gets no colour', () => {
  expect(colourEnabled({ TERM: 'dumb' }, true)).toBe(false)
})

test('paintFor hands back the identity paint when colour is off', () => {
  expect(paintFor({}, false)).toBe(PLAIN)
  expect(paintFor({}, true)).toBe(COLOUR)
})

// --- what colour must never change -------------------------------------------

/**
 * The pinned columns are the report's whole readability, and an escape
 * sequence has length. Padding is computed on the unstyled string and the
 * result styled afterwards; if that order ever inverts, the columns collapse.
 * Stripping the codes back out has to give exactly the plain rendering.
 */
test('stripping the colour codes gives back the plain report byte for byte', () => {
  const r = base()
  r.loaded = [
    { path: '/repo/CLAUDE.md', origin: 'project', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null },
    { path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: '/repo/CLAUDE.md', gitIgnored: true, gitTracked: false },
    { path: '/repo/a/very/deeply/nested/directory/tree/CLAUDE.md', origin: 'user', reason: 'compact', viaImport: null, gitIgnored: null, gitTracked: null },
  ]
  r.missing = [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }]
  r.quiet = [
    { path: '/repo/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' },
    { path: '/repo/.claude/rules/api.md', label: 'path-scoped', rule: 'paths' },
    { path: '/repo/CLAUDE.local.md', label: 'excluded', rule: 'ancestor' },
  ]
  r.config = [{ t: '2026-08-27T06:58:00Z', ev: 'config', source: 'skills', keys: ['a', 'b'] }]
  r.modelDisagrees = ['/odd/CLAUDE.md']
  r.originDisagrees = [{ path: '/repo/CLAUDE.md', claimed: 'User', inferred: 'project' }]
  r.skipped = [
    { path: '/repo/big.md', reason: 'too-large' },
    { path: '/repo/docs/ghost.md', reason: 'missing-target', importer: '/repo/CLAUDE.md' },
  ]

  // eslint-disable-next-line no-control-regex
  const stripped = render(r, COLOUR).replace(/\x1b\[[0-9;]*m/g, '')
  expect(stripped).toBe(render(r))
})

test('the default rendering carries no escape codes at all', () => {
  const r = base()
  r.loaded = [{ path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false }]
  expect(render(r)).not.toContain(ESC)
})

// --- what colour is for ------------------------------------------------------

/**
 * Colour carries the same ranking the wording already does, so the two can
 * never tell the reader different things. FOREIGN is the one finding worth
 * interrupting someone for, and it is the only row in bold red.
 */
test('a foreign row is the only origin rendered in bold red', () => {
  const r = base()
  r.loaded = [
    { path: '/repo/CLAUDE.md', origin: 'project', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null },
    { path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false },
  ]
  const out = render(r, COLOUR)
  expect(out).toContain(`${ESC}[1;31mFOREIGN    ${ESC}[0m`)
  expect(out.match(/\x1b\[1;31m/g)?.length).toBe(1)
})

test('a missing file is coloured as a fault and a quiet one is not', () => {
  const r = base()
  r.missing = [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }]
  r.quiet = [{ path: '/repo/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' }]
  const out = render(r, COLOUR)
  expect(out).toContain(`${ESC}[33mmissing    ${ESC}[0m`)
  expect(out).toContain(`${ESC}[2mquiet      ${ESC}[0m`)
})

test('each section heading is emphasised', () => {
  const r = base()
  r.skipped = [{ path: '/repo/big.md', reason: 'too-large' }]
  const out = render(r, COLOUR)
  for (const heading of ['SESSION', 'LOADED', 'COULD NOT READ']) {
    expect(out).toContain(`${ESC}[1m${heading}${ESC}[0m`)
  }
})

/** Kanon admitting its own model is wrong is a warning, not a heading. */
test('the reachability note is rendered as a warning', () => {
  const r = base()
  r.modelDisagrees = ['/odd/CLAUDE.md']
  expect(render(r, COLOUR)).toContain(`${ESC}[33mNOTE  the reachability model disagrees`)
})
