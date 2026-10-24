import type { MarkedHook } from '../src/inventory'
import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { render } from '../src/render'
import type { Steered } from '../src/steering'
import type { Report } from '../src/types'
import type { Drift } from '../src/drift'

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
    autoMemory: [],
    skipped: [],
    drift: null,
    steered: [],
    injections: [],
    skills: [],
    compactions: [],
    inventory: { hooks: [], skills: [], agentMemory: [] },
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

test('a config change row names its source and the file that changed', () => {
  const r = base()
  r.config = [
    { t: '2026-08-27T06:58:00Z', ev: 'config', source: 'skills', path: '/repo/.claude/skills/x/SKILL.md' },
    { t: '2026-08-27T06:58:00Z', ev: 'config', source: 'user_settings', path: null },
  ]
  const lines = render(r).split('\n')
  expect(lines).toContain('CONFIG CHANGED')
  expect(lines).toContain('  06:58  skills  .claude/skills/x/SKILL.md')
  expect(lines).toContain('  06:58  user_settings')
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
    autoMemory: [],
    missing: [{ path: '/root/Knossos-MCP/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }],
    quiet: [
      { path: '/root/Knossos-MCP/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' },
      { path: '/root/Knossos-MCP/.claude/rules/api.md', label: 'path-scoped', rule: 'paths' },
    ],
    config: [{ t: '2026-08-27T00:52:00Z', ev: 'config', source: 'skills', path: null }],
    modelDisagrees: [],
    skipped: [],
    drift: null,
    steered: [],
    injections: [],
    skills: [],
    compactions: [],
    inventory: { hooks: [], skills: [], agentMemory: [] },
  }
  const out = render(r)
  expect(out).toContain('  user       ~/.claude/rules/context7.md          session_start')
  expect(out).toContain('  project    CLAUDE.md                            session_start')
  expect(out).toContain('  FOREIGN    vendor/phpstan/phpstan/CLAUDE.md     nested_traversal')
  expect(out).toContain('             untracked in this repo')
  expect(out).toContain('  missing    .claude/rules/testing.md             expected at launch')
  expect(out).toContain('  quiet      docs/CLAUDE.md                       on-demand, not triggered')
  expect(out).toContain('  quiet      .claude/rules/api.md                 path-scoped, no match')
  expect(out.split('\n')).toContain('  00:52  skills')
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

const NO_DRIFT: Drift = { appeared: [], vanished: [], changed: [] }

test('the DRIFT section names each change with a fixed-width tag', () => {
  const out = render({
    ...base(),
    drift: {
      appeared: [{ path: '/repo/node_modules/foo/CLAUDE.md', origin: 'foreign', sha256: 'a' }],
      changed: [{ path: '/repo/CLAUDE.md', origin: 'project', sha256: 'b' }],
      vanished: [{ path: '/repo/gone.md', origin: 'project', sha256: 'c' }],
    },
  })
  expect(out).toContain('DRIFT')
  expect(out).toContain('  appeared   node_modules/foo/CLAUDE.md')
  expect(out).toContain('  changed    CLAUDE.md')
  expect(out).toContain('  vanished   gone.md')
  // Pins the section's explanatory note, which is the one line that states
  // what `appeared` means now: never seen governing this repository before,
  // not merely absent from the last session. A silent reversion to a
  // "since your last session" framing would describe behaviour the code no
  // longer has, and nothing else in this section would catch that.
  expect(out).toContain('compared with what has governed this repository before')
})

test('the DRIFT section is omitted when there is no baseline', () => {
  expect(render({ ...base(), drift: null })).not.toContain('DRIFT')
})

test('the DRIFT section is omitted when nothing changed', () => {
  expect(render({ ...base(), drift: NO_DRIFT })).not.toContain('DRIFT')
})

test('DRIFT sits after LOADED and before NOT LOADED', () => {
  const out = render({
    ...base(),
    drift: { appeared: [{ path: '/repo/new.md', origin: 'project', sha256: 'a' }], vanished: [], changed: [] },
    missing: [{ path: '/repo/missing.md', label: 'launch', rule: 'r' }],
  })
  expect(out.indexOf('LOADED')).toBeLessThan(out.indexOf('DRIFT'))
  expect(out.indexOf('DRIFT')).toBeLessThan(out.indexOf('NOT LOADED'))
})

// --- what steered the session: stale flags, memory, injections, skills, compactions

function item(path: string, kind: Steered['kind'], verdict: Steered['verdict'], acknowledged = false): Steered {
  return { path, kind, origin: kind === 'memory' ? 'user' : 'project', digest: 'd', verdict, acknowledged }
}

test('STALE names each flagged item at the pinned columns, acknowledged ones as ok', () => {
  const r = base()
  r.steered = [
    item('/repo/memory/release-flow.md', 'memory', { level: 'gone', evidence: 'names `bun run release`, which no longer exists' }),
    item('/repo/.claude/rules/api.md', 'instruction', { level: 'may-be-stale', evidence: '`src/api.ts` changed after this was written' }),
    item('/repo/memory/old.md', 'memory', { level: 'gone', evidence: 'names `x`, which no longer exists' }, true),
    item('/repo/CLAUDE.md', 'instruction', null),
  ]
  const lines = render(r).split('\n')
  const at = lines.indexOf('STALE')
  expect(at).toBeGreaterThan(-1)
  expect(lines.slice(at, at + 4)).toEqual([
    'STALE',
    '  gone       memory/release-flow.md               names `bun run release`, which no longer exists',
    '  may-stale  .claude/rules/api.md                 `src/api.ts` changed after this was written',
    '  ok         memory/old.md                        acknowledged',
  ])
  // An item with no verdict is not a stale flag of any level.
  expect(lines.slice(at + 4).join('\n')).not.toContain('CLAUDE.md')
})

test('STALE shows a symbol that no longer occurs as may-stale, not gone', () => {
  const r = base()
  r.steered = [item('/repo/.claude/rules/x.md', 'instruction', { level: 'may-be-stale', evidence: 'names `parseThing`, which no longer occurs in the code' })]
  expect(render(r)).toContain('  may-stale  .claude/rules/x.md                   names `parseThing`, which no longer occurs in the code')
})

test('STALE strips control characters from evidence quoted out of a file', () => {
  const r = base()
  r.steered = [item('/repo/memory/a.md', 'memory', { level: 'gone', evidence: 'names `a\x1b[2Kb`, which no longer exists' })]
  const out = render(r)
  expect(out).not.toContain('\x1b')
  expect(out).toContain('names `a[2Kb`, which no longer exists')
})

test('MEMORY lists every memory that steers the session, and no instruction file', () => {
  const r = base()
  const dir = join(homedir(), '.claude', 'projects', '-repo', 'memory')
  r.steered = [
    item('/repo/CLAUDE.md', 'instruction', null),
    item(join(dir, 'MEMORY.md'), 'memory', null),
    item(join(dir, 'release-flow.md'), 'memory', { level: 'gone', evidence: 'e' }),
  ]
  const lines = render(r).split('\n')
  const at = lines.indexOf('MEMORY')
  expect(lines.slice(at)).toEqual([
    'MEMORY',
    '  ~/.claude/projects/-repo/memory/MEMORY.md',
    '  ~/.claude/projects/-repo/memory/release-flow.md',
  ])
  expect(lines.length).toBe(at + 3)
})

test('HOOKS lists every hook by scope, with what each injected', () => {
  const r = base()
  const hook = (over: Partial<MarkedHook>): MarkedHook => ({ scope: 'user', plugin: null, event: 'Stop', matcher: null, command: 'echo done', source: '/s', injected: null, shared: false, ...over })
  r.inventory.hooks = [
    hook({}),
    hook({ scope: 'project', event: 'PreToolUse', matcher: 'Read', command: '/repo/tools/guard.sh', injected: { count: 2, chars: 8600, index: 3 } }),
    hook({ scope: 'plugin', plugin: 'superpowers', event: 'SessionStart', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start', injected: { count: 1, chars: 3400, index: 0 } }),
    hook({ scope: 'other', plugin: 'unattributed', event: 'UserPromptSubmit', command: '', injected: { count: 6, chars: 300, index: 9 } }),
  ]
  const lines = render(r).split('\n')
  const at = lines.indexOf('HOOKS')
  expect(lines.slice(at, at + 5)).toEqual([
    'HOOKS',
    '  user            Stop                  echo done',
    '  project         PreToolUse:Read       tools/guard.sh                       ×2   8.6k chars',
    '  superpowers     SessionStart          "hooks/run-hook.cmd" session-start   ×1   3.4k chars',
    '  unattributed    UserPromptSubmit                                           ×6   0.3k chars',
  ])
})

test('a plugin hook command is written from its plugin root, in either spelling', () => {
  const r = base()
  r.inventory.hooks = [{ scope: 'plugin', plugin: 'p', event: 'Stop', matcher: null, command: 'sh "$CLAUDE_PLUGIN_ROOT/hooks/scripts/turn.sh"', source: '/s', injected: null, shared: false }]
  expect(render(r)).toContain('  p               Stop                  sh "hooks/scripts/turn.sh"')
})

test('a hook whose command another plugin shares says so where it cannot be marked', () => {
  const r = base()
  r.inventory.hooks = [{ scope: 'plugin', plugin: 'one', event: 'SessionStart', matcher: null, command: 'sh "s.sh"', source: '/s', injected: null, shared: true }]
  expect(render(r)).toContain(`  one             SessionStart          ${'sh "s.sh"'.padEnd(37)}shared`)
})

test('a hook command under the home directory is written from ~', () => {
  const r = base()
  r.inventory.hooks = [{ scope: 'user', plugin: null, event: 'Stop', matcher: null, command: `bun ${homedir()}/x.mjs`, source: '/s', injected: null, shared: false }]
  expect(render(r)).toContain('  user            Stop                  bun ~/x.mjs')
})

test('SKILLS lists every skill by scope, the invoked ones marked', () => {
  const r = base()
  r.inventory.skills = [
    { scope: 'user', plugin: null, name: 'house-style', path: '/h/s/SKILL.md', invoked: false },
    { scope: 'plugin', plugin: 'superpowers', name: 'superpowers:brainstorming', path: '/p/SKILL.md', invoked: true },
  ]
  const lines = render(r).split('\n')
  const at = lines.indexOf('SKILLS')
  expect(lines.slice(at, at + 3)).toEqual(['SKILLS', '  user            house-style', '  superpowers     superpowers:brainstorming  invoked'])
})

test('COMPACTION names each compaction with its tokens', () => {
  const r = base()
  r.compactions = [{ t: '2026-10-24T21:40:12.000Z', trigger: 'auto', preTokens: 968_000, postTokens: 25_000 }]
  const lines = render(r).split('\n')
  expect(lines.slice(lines.indexOf('COMPACTION'), lines.indexOf('COMPACTION') + 2)).toEqual(['COMPACTION', '  21:40  auto  968k -> 25k tokens'])
})

test('MEMORY adds each agent memory after the project memory', () => {
  const r = base()
  r.steered = [item('/repo/memory/MEMORY.md', 'memory', null)]
  r.inventory.agentMemory = [{ scope: 'project', agent: 'rev', path: '/repo/.claude/agent-memory/rev/MEMORY.md' }]
  const lines = render(r).split('\n')
  const at = lines.indexOf('MEMORY')
  expect(lines.slice(at, at + 3)).toEqual(['MEMORY', '  memory/MEMORY.md', '  .claude/agent-memory/rev/MEMORY.md  agent rev, project'])
})

test('each steering section is omitted when it has nothing to say', () => {
  const r = base()
  r.steered = [item('/repo/CLAUDE.md', 'instruction', null)]
  const out = render(r)
  for (const heading of ['STALE', 'MEMORY', 'HOOKS', 'SKILLS', 'COMPACTION']) expect(out).not.toContain(heading)
})

test('the steering sections sit after LOADED and before DRIFT, in a fixed order', () => {
  const r = base()
  r.steered = [item('/repo/memory/a.md', 'memory', { level: 'gone', evidence: 'e' })]
  r.inventory.hooks = [{ scope: 'other', plugin: 'unattributed', event: 'SessionStart', matcher: null, command: '', source: '', injected: { count: 1, chars: 10, index: 0 }, shared: false }]
  r.inventory.skills = [{ scope: 'other', plugin: null, name: 's', path: '', invoked: true }]
  r.compactions = [{ t: '2026-10-24T21:40:00Z', trigger: 'manual', preTokens: 1000, postTokens: 1000 }]
  r.drift = { appeared: [{ path: '/repo/new.md', origin: 'project', sha256: 'a' }], vanished: [], changed: [] }
  const lines = render(r).split('\n')
  const order = ['LOADED', 'STALE', 'MEMORY', 'HOOKS', 'SKILLS', 'COMPACTION', 'DRIFT'].map((h) => lines.indexOf(h))
  expect(order.every((i) => i > -1)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
})

test('an agent memory path reaches the report without control characters', () => {
  const r = base()
  r.inventory.agentMemory = [{ scope: 'user', agent: 'rev', path: '/elsewhere/\x1b[31mx\r.md' }]
  const out = render(r)
  expect(out).not.toContain('\x1b')
  expect(out).toContain('/elsewhere/[31mx.md  agent rev, user')
})
