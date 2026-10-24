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
    hooks: [],
    skills: [],
    agentMemory: [],
    compactions: [{ t: '2026-10-24T10:00:00Z', trigger: 'auto', preTokens: 900, postTokens: 100 }],
  })
  expect(m.v).toBe(2)
  expect(m.instructions[0]!.path).toBe(short(foreign, root))
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
  expect(m.hooks).toEqual([])
  expect(m.skills).toEqual([])
  expect(m.compactions).toEqual([])
})

test('the inventory arrives as given, paths shortened and realpathed', () => {
  const { root, rule } = fixture()
  const skill = join(root, '.claude', 'skills', 'deploy', 'SKILL.md')
  mkdirSync(join(root, '.claude', 'skills', 'deploy'), { recursive: true })
  writeFileSync(skill, 'x\n')
  const inv: Inventoried = {
    hooks: [
      { scope: 'project', plugin: null, event: 'Stop', matcher: 'Bash', command: `${root}/tools/done.sh`, source: join(root, '.claude', 'settings.json'), injected: { count: 2, chars: 40, index: 1 }, shared: false },
      { scope: 'plugin', plugin: 'p', event: 'Stop', matcher: null, command: 'sh "${CLAUDE_PLUGIN_ROOT}/a.sh"', source: '/p/hooks/hooks.json', injected: null, shared: false },
      { scope: 'other', plugin: 'unattributed', event: 'Stop', matcher: null, command: '', source: '', injected: { count: 1, chars: 3, index: 0 }, shared: false },
    ],
    skills: [{ scope: 'project', plugin: null, name: 'deploy', path: skill, invoked: true }],
    agentMemory: [{ scope: 'project', agent: 'rev', path: rule }],
  }
  const m = paneModel(null, 'predicted', root, [], inv)
  expect(m.hooks).toEqual([
    { scope: 'project', plugin: null, event: 'Stop', matcher: 'Bash', command: 'tools/done.sh', source: '.claude/settings.json', injected: { count: 2, chars: 40, index: 1 }, shared: false },
    { scope: 'plugin', plugin: 'p', event: 'Stop', matcher: null, command: 'sh "a.sh"', source: '/p/hooks/hooks.json', injected: null, shared: false },
    { scope: 'other', plugin: 'unattributed', event: 'Stop', matcher: null, command: '', source: '', injected: { count: 1, chars: 3, index: 0 }, shared: false },
  ])
  expect(m.skills).toEqual([{ scope: 'project', plugin: null, name: 'deploy', path: '.claude/skills/deploy/SKILL.md', real: skill, invoked: true }])
  expect(m.agentMemory).toEqual([{ scope: 'project', agent: 'rev', path: '.claude/rules/style.md', real: rule }])
})

test('a skill whose transcript path is no file has nothing to open', () => {
  const { root } = fixture()
  const inv: Inventoried = { hooks: [], skills: [{ scope: 'other', plugin: null, name: 'p:s', path: 'plugin:p:s', invoked: true }], agentMemory: [] }
  expect(paneModel(null, 'predicted', root, [], inv).skills).toEqual([{ scope: 'other', plugin: null, name: 'p:s', path: '', real: '', invoked: true }])
})

test('no inventory given lists none', () => {
  const { root } = fixture()
  expect(paneModel(null, 'predicted', root, [])).toMatchObject({ hooks: [], skills: [], agentMemory: [] })
})
