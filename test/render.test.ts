import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { render } from '../src/render'
import type { Report } from '../src/types'

function base(): Report {
  return { root: '/repo', ruleset: '2026-08', loaded: [], missing: [], quiet: [], config: [], modelDisagrees: [], skipped: [] }
}

test('names the root and the ruleset', () => {
  const out = render(base())
  expect(out).toContain('/repo')
  expect(out).toContain('2026-08')
})

test('marks a foreign load in upper case so it cannot be skimmed past', () => {
  const r = base()
  r.loaded = [{ path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false }]
  expect(render(r)).toContain('FOREIGN')
})

test('says an untracked foreign file is untracked', () => {
  const r = base()
  r.loaded = [{ path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false }]
  expect(render(r)).toContain('untracked')
})

test('lists a missing launch candidate under NOT LOADED', () => {
  const r = base()
  r.missing = [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }]
  const out = render(r)
  expect(out).toContain('NOT LOADED')
  expect(out).toContain('missing')
})

test('describes a quiet candidate as not triggered rather than as a fault', () => {
  const r = base()
  r.quiet = [{ path: '/repo/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' }]
  const out = render(r)
  expect(out).toContain('not triggered')
  expect(out).not.toContain('missing')
})

test('warns when the reachability model disagrees with reality', () => {
  const r = base()
  r.modelDisagrees = ['/odd/CLAUDE.md']
  expect(render(r)).toContain('reachability model disagrees')
})

test('renders a config change', () => {
  const r = base()
  r.config = [{ t: '2026-08-27T00:52:00Z', ev: 'config', source: 'skills', keys: ['a', 'b'] }]
  const out = render(r)
  expect(out).toContain('CONFIG CHANGED')
  expect(out).toContain('skills')
})

test('a clean session still renders without throwing', () => {
  expect(render(base()).length).toBeGreaterThan(0)
})

// --- Extra coverage for failure cases found while reviewing the brief ---

test('a foreign file whose tracked status is unknown is not called untracked', () => {
  const r = base()
  r.loaded = [{ path: '/odd/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: null, gitTracked: null }]
  const out = render(r)
  // null means git could not answer (e.g. outside a repository). Rendering
  // it as "untracked in this repo" would assert something git never said.
  expect(out).not.toContain('untracked in this repo')
  expect(out).toContain('tracked status unknown')
})

test('a quiet path-scoped candidate is described as no match, not as not triggered', () => {
  const r = base()
  r.quiet = [{ path: '/repo/.claude/rules/api.md', label: 'path-scoped', rule: 'paths' }]
  const out = render(r)
  expect(out).toContain('path-scoped, no match')
  expect(out).not.toContain('not triggered')
})

test('the model-disagrees note does not blame the user', () => {
  const r = base()
  r.modelDisagrees = ['/odd/CLAUDE.md']
  const out = render(r)
  expect(out).toContain('NOT LOADED section is unreliable')
  expect(out.toLowerCase()).not.toContain('you ')
  expect(out.toLowerCase()).not.toContain('your ')
})

test('a user-origin path under home is shown with a tilde', () => {
  const r = base()
  const p = `${homedir()}/.claude/rules/context7.md`
  r.loaded = [{ path: p, origin: 'user', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null }]
  const out = render(r)
  expect(out).toContain('~/.claude/rules/context7.md')
  expect(out).not.toContain(homedir())
})

test('reproduces the worked example from the design doc column-for-column', () => {
  const r: Report = {
    root: '/root/Knossos-MCP',
    ruleset: '2026-08',
    loaded: [
      { path: join(homedir(), '.claude', 'rules', 'context7.md'), origin: 'user', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null },
      { path: '/root/Knossos-MCP/CLAUDE.md', origin: 'project', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null },
      { path: '/root/Knossos-MCP/vendor/phpstan/phpstan/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false },
    ],
    missing: [{ path: '/root/Knossos-MCP/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }],
    quiet: [
      { path: '/root/Knossos-MCP/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' },
      { path: '/root/Knossos-MCP/.claude/rules/api.md', label: 'path-scoped', rule: 'paths' },
    ],
    config: [{ t: '2026-08-27T00:52:00Z', ev: 'config', source: 'skills', keys: ['a'] }],
    modelDisagrees: [],
    skipped: [],
  }
  const out = render(r)
  expect(out).toContain('  user       ~/.claude/rules/context7.md          session_start')
  expect(out).toContain('  project    CLAUDE.md                            session_start')
  expect(out).toContain('  FOREIGN    vendor/phpstan/phpstan/CLAUDE.md     nested_traversal')
  expect(out).toContain('             untracked in this repo')
  expect(out).toContain('  missing    .claude/rules/testing.md             expected at launch')
  expect(out).toContain('  quiet      docs/CLAUDE.md                       on-demand, not triggered')
  expect(out).toContain('  quiet      .claude/rules/api.md                 path-scoped, no match')
  expect(out).toContain('  00:52  skills  (+1)')
})

test('a path longer than the path column still gets a space before the reason', () => {
  const r = base()
  const path = '/repo/a/very/deeply/nested/directory/tree/CLAUDE.md'
  r.loaded = [{ path, origin: 'project', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null }]
  const out = render(r)
  const rel = path.slice('/repo/'.length)
  // The fused form the pre-fix code produced when a value reached or
  // exceeded the column width: no whitespace at all between path and reason.
  expect(out).not.toContain(`${rel}session_start`)
  // Reason is still present, and separated from the path by whitespace.
  expect(out).toContain(`${rel} session_start`)
})

test('a report with no skips renders no COULD NOT READ section at all', () => {
  const out = render(base())
  expect(out).not.toContain('COULD NOT READ')
})

test('a skipped oversized file is named under COULD NOT READ', () => {
  const r = base()
  r.skipped = [{ path: '/repo/vendor/big.md', reason: 'too-large' }]
  const out = render(r)
  expect(out).toContain('COULD NOT READ')
  expect(out).toContain('vendor/big.md')
  expect(out).toContain('4 MiB')
})

test('a skipped missing import target names the target path and reason', () => {
  const r = base()
  r.skipped = [{ path: '/repo/docs/ghost.md', reason: 'missing-target' }]
  const out = render(r)
  expect(out).toContain('COULD NOT READ')
  expect(out).toContain('docs/ghost.md')
  expect(out).toContain('does not exist')
})

test('a skipped missing import target names the importer when one is known', () => {
  const r = base()
  r.skipped = [{ path: '/repo/docs/ghost.md', reason: 'missing-target', importer: '/repo/CLAUDE.md' }]
  const out = render(r)
  expect(out).toContain('Imported by CLAUDE.md')
})

test('the missing-target tag never fuses into the path column', () => {
  const r = base()
  r.skipped = [{ path: '/repo/docs/ghost.md', reason: 'missing-target' }]
  const out = render(r)
  // "missing target" is 14 characters against an 11-character TAG_WIDTH;
  // pad() must still leave at least one space before the path.
  expect(out).not.toContain('targetdocs/ghost.md')
  expect(out).toContain('missing target docs/ghost.md')
})

test('renders the SESSION line with root and ruleset separated by a gap', () => {
  const r = base()
  r.root = '/root/Knossos-MCP'
  const out = render(r)
  const sessionLine = out.split('\n')[0]
  expect(sessionLine).toBe('SESSION  /root/Knossos-MCP          ruleset 2026-08')
})
