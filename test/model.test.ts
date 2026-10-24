import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_VERSION, paneModel } from '../src/model'
import { short } from '../src/paths'
import type { Steered } from '../src/steering'
import type { Inventoried } from '../src/inventory'
import type { Report } from '../src/types'
import { tmp } from './tmp'

function fixture() {
  const root = tmp('kanon-model-')
  mkdirSync(join(root, 'vendor', 'pkg'), { recursive: true })
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true })
  const foreign = join(root, 'vendor', 'pkg', 'CLAUDE.md')
  const rule = join(root, '.claude', 'rules', 'style.md')
  const memory = join(root, 'release-flow.md')
  for (const f of [foreign, rule, memory]) writeFileSync(f, 'x\n')
  const report = {
    root,
    ruleset: '2026-10',
    loaded: [{ path: foreign, origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: null, gitTracked: null }],
    missing: [], quiet: [], config: [], modelDisagrees: [], originDisagrees: [], skipped: [], drift: null, autoMemory: [],
    steered: [
      { path: foreign, kind: 'instruction', origin: 'foreign', digest: 'd1', verdict: null, acknowledged: false },
      { path: memory, kind: 'memory', origin: 'user', digest: 'd2', verdict: { level: 'gone', evidence: 'names `scripts/release.sh`, which no longer exists' }, acknowledged: false },
      { path: rule, kind: 'instruction', origin: 'project', digest: 'd3', verdict: { level: 'may-be-stale', evidence: 'names `src/old.ts`, last changed after this rule' }, acknowledged: true },
    ] satisfies Steered[],
    injections: [
      { hookName: 'SessionStart:startup', chars: 120, command: 'x', plugin: 'example' },
      { hookName: 'UserPromptSubmit', chars: 30, command: null, plugin: '?' },
    ],
    skills: [{ name: 'example:skill', path: '/home/user/skill' }],
    compactions: [{ t: '2026-10-24T10:00:00Z', trigger: 'auto', preTokens: 900, postTokens: 100 }],
  } as unknown as Report
  return { root, foreign, rule, memory, report }
}

test('paneModel maps a report into the pane contract', () => {
  const { root, foreign, rule, memory, report } = fixture()
  const m = paneModel(report, 'observed', root, report.steered)
  expect(m).toEqual({
    v: MODEL_VERSION,
    root,
    basis: 'observed',
    ruleset: '2026-10',
    instructions: [
      { path: 'vendor/pkg/CLAUDE.md', real: foreign, kind: 'instruction', origin: 'foreign', reason: 'nested_traversal', verdict: null, acknowledged: false },
      { path: '.claude/rules/style.md', real: rule, kind: 'instruction', origin: 'project', reason: null, verdict: { level: 'may-be-stale', evidence: 'names `src/old.ts`, last changed after this rule' }, acknowledged: true },
    ],
    memory: [
      { path: 'release-flow.md', real: memory, kind: 'memory', origin: 'user', reason: null, verdict: { level: 'gone', evidence: 'names `scripts/release.sh`, which no longer exists' }, acknowledged: false },
    ],
    injected: [
      { plugin: 'example', hookName: 'SessionStart:startup', count: 1, chars: 120, index: 0 },
      { plugin: '?', hookName: 'UserPromptSubmit', count: 1, chars: 30, index: 1 },
    ],
    skills: ['example:skill'],
    compactions: [{ t: '2026-10-24T10:00:00Z', trigger: 'auto', preTokens: 900, postTokens: 100 }],
    hooks: [],
    allSkills: [],
    agentMemory: [],
  })
  expect(m.instructions[0]!.path).toBe(short(foreign, root))
})

test('injections collapse to one row per plugin and hook, the most characters first, each naming its most recent', () => {
  const { root, report } = fixture()
  report.injections = [
    { hookName: 'SessionStart', chars: 120, command: 'x', plugin: 'a' },
    { hookName: 'UserPromptSubmit', chars: 30, command: null, plugin: 'unattributed' },
    { hookName: 'UserPromptSubmit', chars: 40, command: null, plugin: 'unattributed' },
    { hookName: 'SessionStart', chars: 5, command: 'x', plugin: 'a' },
    { hookName: 'UserPromptSubmit', chars: 500, command: 'y', plugin: 'b' },
    // Same hook, another plugin: its own row.
    { hookName: 'SessionStart', chars: 1, command: null, plugin: 'unattributed' },
  ]
  expect(paneModel(report, 'observed', root, report.steered).injected).toEqual([
    { plugin: 'b', hookName: 'UserPromptSubmit', count: 1, chars: 500, index: 4 },
    { plugin: 'a', hookName: 'SessionStart', count: 2, chars: 125, index: 3 },
    { plugin: 'unattributed', hookName: 'UserPromptSubmit', count: 2, chars: 70, index: 2 },
    { plugin: 'unattributed', hookName: 'SessionStart', count: 1, chars: 1, index: 5 },
  ])
})

test('a loaded file the judge did not reach is still listed, unjudged', () => {
  const { root, foreign, report } = fixture()
  const m = paneModel(report, 'observed', root, [])
  expect(m.instructions.map((i) => i.real)).toEqual([foreign])
  expect(m.instructions[0]!.verdict).toBeNull()
  expect(m.memory).toEqual([])
})

test('without a report the model is predicted, from steering alone', () => {
  const { root, rule } = fixture()
  const steered: Steered[] = [{ path: rule, kind: 'instruction', origin: 'project', digest: 'd', verdict: null, acknowledged: false }]
  const m = paneModel(null, 'predicted', root, steered)
  expect(m.basis).toBe('predicted')
  expect(m.instructions.map((i) => i.path)).toEqual(['.claude/rules/style.md'])
  expect(m.injected).toEqual([])
  expect(m.skills).toEqual([])
  expect(m.compactions).toEqual([])
})

test('the inventory arrives as given, paths shortened and realpathed', () => {
  const { root, rule } = fixture()
  const skill = join(root, '.claude', 'skills', 'deploy', 'SKILL.md')
  mkdirSync(join(root, '.claude', 'skills', 'deploy'), { recursive: true })
  writeFileSync(skill, 'x\n')
  const inv: Inventoried = {
    hooks: [{ scope: 'user', plugin: null, event: 'Stop', matcher: 'Bash', command: 'c', source: '/s', injected: { count: 2, chars: 40, index: 1 } }],
    skills: [{ scope: 'project', plugin: null, name: 'deploy', path: skill, invoked: true }],
    agentMemory: [{ scope: 'project', agent: 'rev', path: rule }],
  }
  const m = paneModel(null, 'predicted', root, [], inv)
  expect(m.hooks).toEqual([{ scope: 'user', plugin: null, event: 'Stop', matcher: 'Bash', command: 'c', injected: { count: 2, chars: 40, index: 1 } }])
  expect(m.allSkills).toEqual([{ scope: 'project', plugin: null, name: 'deploy', path: '.claude/skills/deploy/SKILL.md', real: skill, invoked: true }])
  expect(m.agentMemory).toEqual([{ scope: 'project', agent: 'rev', path: '.claude/rules/style.md', real: rule }])
})

test('no inventory given lists none', () => {
  const { root } = fixture()
  expect(paneModel(null, 'predicted', root, [])).toMatchObject({ hooks: [], allSkills: [], agentMemory: [] })
})
