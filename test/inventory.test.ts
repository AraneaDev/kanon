import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { byScope, inventory, markHooks, markSkills, type Hook, type Places } from '../src/inventory'
import { tmp } from './tmp'

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Claude Code runs only plugins set to true; world() enables `plug` in project settings. */
const ON = { enabledPlugins: { 'plug@mkt': true } }

const hooksOf = (event: string, command: string, matcher?: string) =>
  JSON.stringify({ hooks: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }] } })

/** A home, a repo and a managed dir, with one plugin `plug` installed for the user. */
function world(): Places & { base: string; plugRoot: string } {
  const base = tmp('kanon-inv-')
  const claudeHome = join(base, 'home', '.claude')
  const root = join(base, 'repo')
  const managed = join(base, 'managed')
  mkdirSync(root, { recursive: true })
  mkdirSync(managed, { recursive: true })
  const plugRoot = join(claudeHome, 'plugins', 'cache', 'mkt', 'plug', '1.0.0')
  mkdirSync(plugRoot, { recursive: true })
  writeInstalled(claudeHome, { 'plug@mkt': [{ scope: 'user', installPath: plugRoot }] })
  put(join(root, '.claude', 'settings.json'), JSON.stringify(ON))
  return { base, claudeHome, root, managedDirs: [`${managed}/`], plugRoot }
}

function writeInstalled(claudeHome: string, plugins: Record<string, unknown[]>): void {
  put(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
}

describe('inventory: hooks', () => {
  test('settings hooks are listed per scope', () => {
    const w = world()
    put(join(w.claudeHome, 'settings.json'), hooksOf('PostToolUse', 'u-cmd', 'Bash'))
    put(join(w.root, '.claude', 'settings.json'), JSON.stringify({ ...ON, ...JSON.parse(hooksOf('PostToolUse', 'p-cmd')) }))
    put(join(w.root, '.claude', 'settings.local.json'), hooksOf('Stop', 'l-cmd'))
    const hooks = inventory(w).hooks
    expect(hooks.map((h) => [h.scope, h.event, h.matcher, h.command])).toEqual([
      ['user', 'PostToolUse', 'Bash', 'u-cmd'],
      ['project', 'PostToolUse', null, 'p-cmd'],
      ['local', 'Stop', null, 'l-cmd'],
    ])
    expect(hooks[0]!.source).toBe(join(w.claudeHome, 'settings.json'))
  })

  test('an http hook lists its url and a prompt hook its prompt', () => {
    const w = world()
    put(
      join(w.claudeHome, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://example.com/h' }, { type: 'prompt', prompt: 'check it' }] }] } }),
    )
    expect(inventory(w).hooks.map((h) => h.command)).toEqual(['https://example.com/h', 'check it'])
  })

  test('managed settings hooks are scope managed', () => {
    const w = world()
    put(join(w.managedDirs[0]!, 'managed-settings.json'), hooksOf('SessionStart', 'm-cmd'))
    expect(inventory(w).hooks.map((h) => [h.scope, h.command])).toEqual([['managed', 'm-cmd']])
  })

  test("an active plugin's hooks.json is listed under its name", () => {
    const w = world()
    put(join(w.plugRoot, 'hooks', 'hooks.json'), hooksOf('SessionStart', 'sh "$CLAUDE_PLUGIN_ROOT/a.sh"'))
    expect(inventory(w).hooks.map((h) => [h.scope, h.plugin, h.command])).toEqual([['plugin', 'plug', 'sh "$CLAUDE_PLUGIN_ROOT/a.sh"']])
  })

  test("a manifest's hooks path is read beside hooks/hooks.json", () => {
    const w = world()
    put(join(w.plugRoot, 'hooks', 'hooks.json'), hooksOf('Stop', 'default'))
    put(join(w.plugRoot, 'config', 'h.json'), hooksOf('Stop', 'from-manifest'))
    put(join(w.plugRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'plug', hooks: './config/h.json' }))
    expect(inventory(w).hooks.map((h) => h.command)).toEqual(['default', 'from-manifest'])
  })
})

describe('inventory: active plugins', () => {
  test('a plugin installed for another project is not active', () => {
    const w = world()
    writeInstalled(w.claudeHome, { 'plug@mkt': [{ scope: 'project', projectPath: join(w.base, 'elsewhere'), installPath: w.plugRoot }] })
    expect(inventory(w).plugins).toEqual([])
  })

  test('a project-scoped plugin for this root is active', () => {
    const w = world()
    writeInstalled(w.claudeHome, { 'plug@mkt': [{ scope: 'project', projectPath: w.root, installPath: w.plugRoot }] })
    expect(inventory(w).plugins.map((p) => [p.name, p.key, p.root])).toEqual([['plug', 'plug@mkt', w.plugRoot]])
  })

  test('only enabledPlugins true runs a plugin, the nearer settings winning', () => {
    const w = world()
    put(join(w.root, '.claude', 'settings.json'), '{}')
    expect(inventory(w).plugins).toEqual([])
    put(join(w.claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'plug@mkt': false } }))
    expect(inventory(w).plugins).toEqual([])
    put(join(w.root, '.claude', 'settings.local.json'), JSON.stringify(ON))
    expect(inventory(w).plugins.map((p) => p.name)).toEqual(['plug'])
    put(join(w.managedDirs[0]!, 'managed-settings.json'), JSON.stringify({ enabledPlugins: { 'plug@mkt': false } }))
    expect(inventory(w).plugins).toEqual([])
  })

  test('a symlinked installPath is skipped', () => {
    const w = world()
    const link = join(w.claudeHome, 'plugins', 'cache', 'mkt', 'plug', 'link')
    symlinkSync(w.plugRoot, link)
    writeInstalled(w.claudeHome, { 'plug@mkt': [{ scope: 'user', installPath: link }] })
    expect(inventory(w).plugins).toEqual([])
  })

  test('an installPath outside plugins/ is skipped', () => {
    const w = world()
    const outside = join(w.base, 'outside')
    put(join(outside, 'hooks', 'hooks.json'), hooksOf('Stop', 'x'))
    writeInstalled(w.claudeHome, { 'plug@mkt': [{ scope: 'user', installPath: outside }] })
    expect(inventory(w)).toMatchObject({ plugins: [], hooks: [] })
  })
})

describe('inventory: skills and agent memory', () => {
  test('skills are listed from every place', () => {
    const w = world()
    put(join(w.claudeHome, 'skills', 'a', 'SKILL.md'), '---\ndescription: a\n---\nbody')
    put(join(w.claudeHome, 'commands', 'b.md'), 'body')
    put(join(w.root, '.claude', 'skills', 'c', 'SKILL.md'), '---\nname: other\n---\nbody')
    put(join(w.root, '.claude', 'commands', 'd.md'), 'body')
    put(join(w.plugRoot, 'skills', 'e', 'SKILL.md'), 'body')
    put(join(w.plugRoot, 'commands', 'f.md'), 'body')
    expect(inventory(w).skills.map((s) => [s.scope, s.plugin, s.name])).toEqual([
      ['user', null, 'a'],
      ['user', null, 'b'],
      ['project', null, 'other'],
      ['project', null, 'd'],
      ['plugin', 'plug', 'plug:e'],
      ['plugin', 'plug', 'plug:f'],
    ])
    expect(inventory(w).skills[0]!.path).toBe(join(w.claudeHome, 'skills', 'a', 'SKILL.md'))
  })

  test('a plugin with a root SKILL.md and no skills/ is one skill', () => {
    const w = world()
    put(join(w.plugRoot, 'SKILL.md'), 'body')
    expect(inventory(w).skills.map((s) => s.name)).toEqual(['plug:plug'])
  })

  test('agent memory is listed per scope, MEMORY.md first', () => {
    const w = world()
    put(join(w.claudeHome, 'agent-memory', 'rev', 'z.md'), 'x')
    put(join(w.claudeHome, 'agent-memory', 'rev', 'MEMORY.md'), 'x')
    put(join(w.root, '.claude', 'agent-memory', 'rev', 'x.md'), 'x')
    put(join(w.root, '.claude', 'agent-memory-local', 'rev', 'y.md'), 'x')
    expect(inventory(w).agentMemory.map((m) => [m.scope, m.agent, m.path.slice(w.base.length)])).toEqual([
      ['user', 'rev', '/home/.claude/agent-memory/rev/MEMORY.md'],
      ['user', 'rev', '/home/.claude/agent-memory/rev/z.md'],
      ['project', 'rev', '/repo/.claude/agent-memory/rev/x.md'],
      ['local', 'rev', '/repo/.claude/agent-memory-local/rev/y.md'],
    ])
  })

  test('a malformed file skips only itself', () => {
    const w = world()
    put(join(w.claudeHome, 'settings.json'), '{ not json')
    put(join(w.root, '.claude', 'settings.json'), JSON.stringify({ ...ON, ...JSON.parse(hooksOf('Stop', 'p-cmd')) }))
    put(join(w.plugRoot, 'hooks', 'hooks.json'), JSON.stringify([1, 'x', null]))
    put(join(w.claudeHome, 'skills', 'a', 'SKILL.md'), '---\nname: [unclosed\n')
    const inv = inventory(w)
    expect(inv.hooks.map((h) => h.command)).toEqual(['p-cmd'])
    expect(inv.skills.map((s) => s.name)).toEqual(['a'])
    put(join(w.claudeHome, 'plugins', 'installed_plugins.json'), 'garbage')
    expect(inventory(w).plugins).toEqual([])
  })
})

test('byScope orders managed, user, project, local, plugins by name, other', () => {
  const xs = [
    { scope: 'other' as const, plugin: 'unattributed', id: 7 },
    { scope: 'plugin' as const, plugin: 'zed', id: 6 },
    { scope: 'plugin' as const, plugin: 'abc', id: 5 },
    { scope: 'local' as const, plugin: null, id: 4 },
    { scope: 'project' as const, plugin: null, id: 3 },
    { scope: 'user' as const, plugin: null, id: 2 },
    { scope: 'managed' as const, plugin: null, id: 1 },
  ]
  expect(byScope(xs).map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
})

describe('marks', () => {
  const hook = (over: Partial<Hook>): Hook => ({ scope: 'user', plugin: null, event: 'SessionStart', matcher: null, command: 'c', source: '/s', ...over })
  const inj = (hookName: string, command: string | null, plugin: string, chars = 10) => ({ hookName, command, plugin, chars })

  test('an injection marks the hook with its command and event, summed, index the most recent', () => {
    const hooks = [hook({ command: 'a' }), hook({ command: 'b' })]
    const marked = markHooks(hooks, [inj('SessionStart:compact', 'a', 'unattributed', 5), inj('Stop', 'a', 'x'), inj('SessionStart:startup', 'a', 'unattributed', 7)])
    expect(marked.map((h) => [h.command, h.injected])).toEqual([
      ['a', { count: 2, chars: 12, index: 2 }],
      ['b', null],
      ['a', { count: 1, chars: 10, index: 1 }],
    ])
    expect(marked[2]).toMatchObject({ scope: 'other', plugin: 'x', event: 'Stop' })
  })

  test('a command two plugins share marks only the plugin attribution names', () => {
    const shared = 'sh "$CLAUDE_PLUGIN_ROOT/s.sh"'
    const hooks = [hook({ scope: 'plugin', plugin: 'one', command: shared }), hook({ scope: 'plugin', plugin: 'two', command: shared })]
    expect(markHooks(hooks, [inj('SessionStart', shared, 'two')]).map((h) => [h.plugin, h.injected?.count ?? 0])).toEqual([
      ['one', 0],
      ['two', 1],
    ])
  })

  test('within a scope the most injected characters come first', () => {
    const hooks = [hook({ command: 'small' }), hook({ command: 'none' }), hook({ command: 'big' })]
    const marked = markHooks(hooks, [inj('SessionStart', 'small', 'u', 3), inj('SessionStart', 'big', 'u', 30)])
    expect(marked.map((h) => h.command)).toEqual(['big', 'small', 'none'])
  })

  test('a null command injection is other with an empty command', () => {
    expect(markHooks([], [inj('UserPromptSubmit', null, 'unattributed')])).toEqual([
      { scope: 'other', plugin: 'unattributed', event: 'UserPromptSubmit', matcher: null, command: '', source: '', injected: { count: 1, chars: 10, index: 0 }, shared: false },
    ])
  })

  test('a skill is invoked by its name or by its path', () => {
    const base = tmp('kanon-mark-')
    put(join(base, 'b', 'SKILL.md'), 'x')
    const skills = [
      { scope: 'user' as const, plugin: null, name: 'a', path: join(base, 'a', 'SKILL.md') },
      { scope: 'user' as const, plugin: null, name: 'b', path: join(base, 'b', 'SKILL.md') },
      { scope: 'user' as const, plugin: null, name: 'c', path: join(base, 'c', 'SKILL.md') },
    ]
    expect(markSkills(skills, [{ name: 'a', path: '' }, { name: 'renamed', path: join(base, 'b', 'SKILL.md') }]).map((s) => s.invoked)).toEqual([true, true, false])
  })

  test('an invoked skill the inventory does not list closes the list as other', () => {
    expect(markSkills([], [{ name: 'run', path: '' }])).toEqual([{ scope: 'other', plugin: null, name: 'run', path: '', invoked: true }])
  })
})

describe('marks, as Claude Code runs hooks', () => {
  const hook = (over: Partial<Hook>): Hook => ({ scope: 'plugin', plugin: 'p', event: 'PreToolUse', matcher: null, command: 'c', source: '/s', ...over })
  const inj = (hookName: string, command: string | null, plugin: string, chars = 10) => ({ hookName, command, plugin, chars })

  test('one command under several matchers marks the hook whose matcher the tool name meets', () => {
    const hooks = [hook({ matcher: 'Bash' }), hook({ matcher: 'Read|Grep' }), hook({ matcher: 'mcp__.*' })]
    const marked = markHooks(hooks, [inj('PreToolUse:Grep', 'c', 'p'), inj('PreToolUse:mcp__x__y', 'c', 'p')])
    expect(marked.map((h) => [h.matcher, h.injected?.count ?? 0])).toEqual([
      ['Read|Grep', 1],
      ['mcp__.*', 1],
      ['Bash', 0],
    ])
    expect(marked.some((h) => h.scope === 'other')).toBe(false)
  })

  test('a command two plugins share, unattributed, marks neither, says so on both, and names both on the other row', () => {
    const shared = 'sh "$CLAUDE_PLUGIN_ROOT/s.sh"'
    const hooks = [hook({ plugin: 'one', event: 'SessionStart', command: shared }), hook({ plugin: 'two', event: 'SessionStart', command: shared })]
    const marked = markHooks(hooks, [inj('SessionStart:startup', shared, 'unattributed')])
    expect(marked.map((h) => [h.scope, h.plugin, h.injected?.count ?? 0, h.shared])).toEqual([
      ['plugin', 'one', 0, true],
      ['plugin', 'two', 0, true],
      ['other', 'one or two', 1, false],
    ])
  })

  test('a hook no injection could belong to is not shared', () => {
    expect(markHooks([hook({})], []).map((h) => h.shared)).toEqual([false])
  })
})

describe('plugin hooks from the manifest', () => {
  test('a manifest hooks path is merged with hooks/hooks.json, inline objects included', () => {
    const w = world()
    put(join(w.plugRoot, 'hooks', 'hooks.json'), hooksOf('Stop', 'default'))
    put(join(w.plugRoot, 'config', 'h.json'), hooksOf('Stop', 'from-file'))
    put(
      join(w.plugRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'plug', hooks: ['./config/h.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'inline' }] }] } }, './hooks/hooks.json'] }),
    )
    expect(inventory(w).hooks.map((h) => h.command)).toEqual(['default', 'from-file', 'inline'])
  })
})
