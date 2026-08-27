import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
    originDisagrees: [],
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

/**
 * An origin disagreement is a different admission from the reachability one:
 * it says a row in LOADED may name the wrong origin, not that NOT LOADED is
 * unreliable. It gets its own section so the two are never confused.
 */
test('names an origin disagreement and what each side said', () => {
  const r = base()
  r.originDisagrees = [{ path: '/repo/CLAUDE.md', claimed: 'User', inferred: 'project' }]

  const out = render(r)

  expect(out).toContain('ORIGIN DISAGREEMENT')
  expect(out).toContain('CLAUDE.md')
  expect(out).toContain('Claude Code says User, Kanon inferred project')
})

test('says nothing about origin disagreements when there are none', () => {
  expect(render(base())).not.toContain('ORIGIN DISAGREEMENT')
})

/**
 * `excluded` is the third quiet label, and the only one that names a
 * decision the user made. It must read as a setting doing its job, never as
 * a fault: sharing vocabulary with `missing` here would report the user's
 * own claudeMdExcludes back to them as a problem.
 */
test('a quiet candidate excluded by settings names the setting rather than reading as a fault', () => {
  const r = base()
  r.quiet = [{ path: '/repo/CLAUDE.md', label: 'excluded', rule: 'ancestor' }]
  const out = render(r)
  expect(out).toContain('excluded by claudeMdExcludes')
  expect(out).not.toContain('missing')
})

test('an unreadable skip is named under COULD NOT READ and says what to check', () => {
  const r = base()
  r.skipped = [{ path: '/repo/.claude/rules/locked.md', reason: 'unreadable' }]
  const out = render(r)
  expect(out).toContain('COULD NOT READ')
  expect(out).toContain('  unreadable .claude/rules/locked.md')
  expect(out).toContain('permission')
})

/**
 * The two disagreement sections answer different questions and must not be
 * confused for one another: an origin column being wrong says nothing about
 * whether NOT LOADED can be trusted, and vice versa.
 */
test('an origin disagreement does not mark the NOT LOADED section unreliable', () => {
  const r = base()
  r.originDisagrees = [{ path: '/repo/CLAUDE.md', claimed: 'User', inferred: 'project' }]
  const out = render(r)
  expect(out).toContain('ORIGIN DISAGREEMENT')
  expect(out).not.toContain('NOT LOADED section is unreliable')
})

/**
 * NOT LOADED exists to name absences. With nothing absent the heading would
 * be an empty promise, so it is not printed at all.
 */
test('a report with nothing absent renders no NOT LOADED section', () => {
  const r = base()
  r.loaded = [{ path: '/repo/CLAUDE.md', origin: 'project', reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null }]
  expect(render(r)).not.toContain('NOT LOADED')
})

test('a session with nothing recorded says so rather than showing an empty LOADED section', () => {
  const out = render(base())
  expect(out).toContain('LOADED')
  expect(out).toContain('nothing recorded')
})

/**
 * git-ignored is only added on top of the tracked note, never instead of it:
 * a vendored file being ignored is the ordinary case, and the reader needs
 * both facts to tell it from one that was committed deliberately.
 */
test('a git-ignored foreign file carries both notes on one line', () => {
  const r = base()
  r.loaded = [{ path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: true, gitTracked: false }]
  expect(render(r)).toContain('untracked in this repo, git-ignored')
})

/** git-ignored is a foreign-only signal, so a false must add nothing at all. */
test('a foreign file that is not git-ignored says nothing about ignoring', () => {
  const r = base()
  r.loaded = [{ path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false }]
  expect(render(r)).not.toContain('git-ignored')
})

/**
 * The import note is what makes a file four hops down the @path graph
 * explicable at all, and it is not a foreign-only signal: a project file
 * pulled in by an import is exactly as surprising to find in the list.
 */
test('a non-foreign file reached through an import still names its importer', () => {
  const r = base()
  r.loaded = [{ path: '/repo/docs/extra.md', origin: 'project', reason: 'session_start', viaImport: '/repo/CLAUDE.md', gitIgnored: null, gitTracked: null }]
  const out = render(r)
  expect(out).toContain('imported by CLAUDE.md')
  expect(out).not.toContain('tracked')
})

/**
 * The tag column is pinned, so a `too large` tag with a space in it must
 * still land the path where every other row puts it.
 */
test('the too-large tag lands the path in the same column as every other skip', () => {
  const r = base()
  r.skipped = [
    { path: '/repo/big.md', reason: 'too-large' },
    { path: '/repo/locked.md', reason: 'unreadable' },
  ]
  const out = render(r)
  expect(out).toContain('  too large  big.md')
  expect(out).toContain('  unreadable locked.md')
})
