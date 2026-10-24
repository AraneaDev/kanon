import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { realPath } from './paths'

/**
 * Everything a session can see beyond its instruction files: the hooks that
 * are configured, the skills that are available and the memory subagents
 * keep. Read from Claude Code's settings files and plugin trees, never from
 * the transcript, so a hook that stayed silent and a skill nobody invoked are
 * listed too (user decision, 2026-10-24: "we should show global too").
 *
 * Pure reads. Every file is optional and a malformed one is skipped on its
 * own, because this runs inside hooks and a hook must never fail a session.
 */

export type Scope = 'managed' | 'user' | 'project' | 'local' | 'plugin' | 'other'

export interface Plugin {
  name: string
  /** `name@marketplace`, the key `enabledPlugins` and installed_plugins.json use. */
  key: string
  /** The realpath of its installPath. */
  root: string
}

export interface Hook {
  scope: Scope
  plugin: string | null
  event: string
  matcher: string | null
  /** The command, or for an http hook its url and for a prompt hook its prompt. */
  command: string
  /** The file it was read from. */
  source: string
}

export interface Skill {
  scope: Scope
  plugin: string | null
  /** As it is invoked: a plugin skill carries its plugin's prefix. */
  name: string
  /** Its SKILL.md, or the command's .md. */
  path: string
}

export interface AgentMemory {
  scope: 'user' | 'project' | 'local'
  agent: string
  path: string
}

export interface Inventory {
  plugins: Plugin[]
  hooks: Hook[]
  skills: Skill[]
  agentMemory: AgentMemory[]
}

export interface Places {
  root: string
  claudeHome: string
  /** Where managed settings live: MANAGED_POLICY_DIRS in production. */
  managedDirs: string[]
}

export const SCOPE_ORDER: Scope[] = ['managed', 'user', 'project', 'local', 'plugin', 'other']

/** Stable sort into SCOPE_ORDER, plugins by name; order within a scope is kept. */
export function byScope<T extends { scope: Scope; plugin: string | null }>(xs: T[]): T[] {
  const rank = (x: T) => SCOPE_ORDER.indexOf(x.scope)
  return [...xs].sort((a, b) => rank(a) - rank(b) || (a.scope === 'plugin' ? (a.plugin ?? '').localeCompare(b.plugin ?? '') : 0))
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Entry names in a directory, sorted. `follow` decides whether a symlinked
 * entry counts: a skill directory linked in from a dotfiles repository is
 * ordinary, but inside the plugin cache a link could lead anywhere, so there
 * it is inspected as itself and skipped (the rule prune() and pluginIndex keep).
 */
function entries(dir: string, want: 'dir' | 'file', follow: boolean): string[] {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names.filter((n) => {
    try {
      const st = follow ? statSync(join(dir, n)) : lstatSync(join(dir, n))
      return want === 'dir' ? st.isDirectory() : st.isFile()
    } catch {
      return false
    }
  })
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The settings files that carry hooks and enabledPlugins, nearest last. */
function settingsFiles(p: Places): Array<{ scope: Scope; path: string }> {
  return [
    ...p.managedDirs.map((d) => ({ scope: 'managed' as const, path: join(d, 'managed-settings.json') })),
    { scope: 'user', path: join(p.claudeHome, 'settings.json') },
    { scope: 'project', path: join(p.root, '.claude', 'settings.json') },
    { scope: 'local', path: join(p.root, '.claude', 'settings.local.json') },
  ]
}

/** Every hook in a settings-shaped `hooks` value: `{ <Event>: [{ matcher?, hooks: [...] }] }`. */
function hooksIn(value: unknown, scope: Scope, plugin: string | null, source: string): Hook[] {
  const out: Hook[] = []
  for (const [event, groups] of Object.entries(obj(value) ?? {})) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      const group = obj(g)
      if (!group || !Array.isArray(group.hooks)) continue
      const matcher = str(group.matcher)
      for (const h of group.hooks) {
        const hook = obj(h)
        const command = hook && (str(hook.command) ?? str(hook.url) ?? str(hook.prompt))
        if (command) out.push({ scope, plugin, event, matcher, command, source })
      }
    }
  }
  return out
}

/**
 * The plugins this session runs: installed for the user or for this root,
 * the nearest install winning, and switched on in enabledPlugins. An
 * installPath that is a symlink or resolves outside `<claudeHome>/plugins/`
 * is skipped, so nothing here reads beyond the plugin cache.
 */
function activePlugins(p: Places): Plugin[] {
  const installed = obj(obj(readJson(join(p.claudeHome, 'plugins', 'installed_plugins.json')))?.plugins)
  if (!installed) return []
  const root = realPath(p.root)
  const cacheRoot = `${realPath(join(p.claudeHome, 'plugins'))}/`

  // Managed is applied last so it wins; otherwise the nearer file wins.
  const enabled = new Map<string, boolean>()
  const files = settingsFiles(p)
  for (const f of [...files.filter((f) => f.scope !== 'managed'), ...files.filter((f) => f.scope === 'managed')]) {
    for (const [k, v] of Object.entries(obj(obj(readJson(f.path))?.enabledPlugins) ?? {})) if (typeof v === 'boolean') enabled.set(k, v)
  }

  const nearness = { user: 0, project: 1, local: 2 } as Record<string, number>
  const out: Plugin[] = []
  for (const [key, list] of Object.entries(installed)) {
    // Only an explicit true runs a plugin. The docs default an unset entry to
    // enabled, but Claude Code counted 11 plugins on a machine with 14
    // installed, and the 11 were exactly the ones set to true.
    if (!Array.isArray(list) || enabled.get(key) !== true) continue
    const applies = list
      .map(obj)
      .filter((e): e is Obj => e !== null && str(e.installPath) !== null && str(e.scope) !== null && str(e.scope)! in nearness)
      .filter((e) => e.scope === 'user' || (str(e.projectPath) !== null && realPath(str(e.projectPath)!) === root))
      .sort((a, b) => nearness[str(b.scope)!]! - nearness[str(a.scope)!]!)
    const pick = applies[0]
    if (!pick) continue
    const installPath = str(pick.installPath)!
    try {
      if (!lstatSync(installPath).isDirectory()) continue
    } catch {
      continue
    }
    const real = realPath(installPath)
    if (!real.startsWith(cacheRoot)) continue
    out.push({ name: key.split('@')[0]!, key, root: real })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** A path list from a manifest key that takes a string or an array of strings. */
const pathList = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Inside the plugin, or nothing: a manifest path cannot lead out of its plugin. */
function inside(plugin: Plugin, rel: string): string | null {
  const abs = resolve(plugin.root, rel)
  return abs === plugin.root || abs.startsWith(`${plugin.root}/`) ? abs : null
}

/**
 * Every hook a plugin declares. hooks/hooks.json loads first and the
 * manifest's `hooks` key adds to it, as Claude Code merges them: a path, an
 * inline object, or an array of either. A file named twice is read once.
 */
function pluginHooks(plugin: Plugin): Hook[] {
  const manifestPath = join(plugin.root, '.claude-plugin', 'plugin.json')
  const declared = obj(readJson(manifestPath))?.hooks
  const defaultFile = join(plugin.root, 'hooks', 'hooks.json')
  const files = [defaultFile]
  const inline: unknown[] = []
  for (const d of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
    if (obj(d)) inline.push(d)
    const f = typeof d === 'string' ? inside(plugin, d) : null
    if (f !== null && !files.includes(f)) files.push(f)
  }
  return [
    ...files.flatMap((f) => hooksIn(obj(readJson(f))?.hooks, 'plugin', plugin.name, f)),
    ...inline.flatMap((d) => hooksIn(obj(d)!.hooks ?? d, 'plugin', plugin.name, manifestPath)),
  ]
}

const NAME = /^[\w.:-]+$/

/** A SKILL.md's frontmatter `name`, when it is a plain name. */
function frontmatterName(path: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8').replace(/^﻿/, '')
  } catch {
    return null
  }
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const m = /^name\s*:\s*["']?([^"'\n]*?)["']?\s*$/m.exec(text.slice(3, end))
  return m && NAME.test(m[1]!) ? m[1]! : null
}

/** `<dir>/<name>/SKILL.md` and `<commands>/*.md`, named as a personal or project directory names them. */
function dirSkills(skillsDir: string, commandsDir: string, scope: Scope, follow: boolean, prefix: string | null, plugin: string | null): Skill[] {
  const named = (n: string) => (prefix ? `${prefix}:${n}` : n)
  const out: Skill[] = []
  for (const d of entries(skillsDir, 'dir', follow)) {
    const path = join(skillsDir, d, 'SKILL.md')
    if (isFile(path)) out.push({ scope, plugin, name: named(frontmatterName(path) ?? d), path })
  }
  for (const f of entries(commandsDir, 'file', follow)) {
    if (f.endsWith('.md')) out.push({ scope, plugin, name: named(f.slice(0, -3)), path: join(commandsDir, f) })
  }
  return out
}

function pluginSkills(plugin: Plugin): Skill[] {
  const manifest = obj(readJson(join(plugin.root, '.claude-plugin', 'plugin.json')))
  const skillsDir = join(plugin.root, 'skills')
  const out = dirSkills(skillsDir, join(plugin.root, 'commands'), 'plugin', false, plugin.name, plugin.name)
  for (const extra of pathList(manifest?.skills).map((r) => inside(plugin, r)).filter((d): d is string => d !== null && d !== skillsDir)) {
    out.push(...dirSkills(extra, '', 'plugin', false, plugin.name, plugin.name))
  }
  // A plugin that is one skill: a root SKILL.md, no skills/ and no skills key.
  const single = join(plugin.root, 'SKILL.md')
  if (!out.length && manifest?.skills === undefined && entries(plugin.root, 'dir', false).indexOf('skills') === -1 && isFile(single)) {
    out.push({ scope: 'plugin', plugin: plugin.name, name: `${plugin.name}:${frontmatterName(single) ?? plugin.name}`, path: single })
  }
  return out
}

function agentMemory(p: Places): AgentMemory[] {
  const places: Array<[AgentMemory['scope'], string]> = [
    ['user', join(p.claudeHome, 'agent-memory')],
    ['project', join(p.root, '.claude', 'agent-memory')],
    ['local', join(p.root, '.claude', 'agent-memory-local')],
  ]
  const out: AgentMemory[] = []
  for (const [scope, dir] of places) {
    for (const agent of entries(dir, 'dir', true)) {
      const files = entries(join(dir, agent), 'file', true).filter((f) => f.endsWith('.md'))
      files.sort((a, b) => Number(b === 'MEMORY.md') - Number(a === 'MEMORY.md'))
      for (const f of files) out.push({ scope, agent, path: join(dir, agent, f) })
    }
  }
  return out
}

export function inventory(p: Places): Inventory {
  const plugins = activePlugins(p)
  const hooks = [
    ...settingsFiles(p).flatMap((f) => hooksIn(obj(readJson(f.path))?.hooks, f.scope, null, f.path)),
    ...plugins.flatMap(pluginHooks),
  ]
  const skills = [
    ...dirSkills(join(p.claudeHome, 'skills'), join(p.claudeHome, 'commands'), 'user', true, null, null),
    ...dirSkills(join(p.root, '.claude', 'skills'), join(p.root, '.claude', 'commands'), 'project', true, null, null),
    ...plugins.flatMap(pluginSkills),
  ]
  return { plugins, hooks: byScope(hooks), skills: byScope(skills), agentMemory: agentMemory(p) }
}


export interface MarkedHook extends Hook {
  /** Its injections this run: how many, their characters together, the index of the most recent. */
  injected: { count: number; chars: number; index: number } | null
  /**
   * Another plugin's hook runs the same command for the same event, and an
   * injection came from one of them: the transcript names a command, never a
   * plugin, so which one added it cannot be told. The injection is listed
   * under `other`, and this hook does not claim it added nothing.
   */
  shared: boolean
}

export interface MarkedSkill extends Skill {
  invoked: boolean
}

/** The inventory as the report and the pane list it, marked against the run. */
export interface Inventoried {
  hooks: MarkedHook[]
  skills: MarkedSkill[]
  agentMemory: AgentMemory[]
}

export const EMPTY_INVENTORIED: Inventoried = { hooks: [], skills: [], agentMemory: [] }

/** `SessionStart:compact` is the SessionStart event; the part after the colon is its source or matcher. */
const eventOf = (hookName: string): string => hookName.split(':')[0]!

interface Ran { hookName: string; command: string | null; plugin: string; chars: number }

/**
 * Each injection marks the configured hook that printed it: same command,
 * same event, and when several plugins ship that command, the one
 * attribution named. One that no hook explains (a mod, a skill's own hook,
 * a plugin since removed) is listed as `other`, so nothing the pane showed
 * before this inventory existed goes missing. Within a scope the most
 * characters come first, since that is the hook costing the most context.
 */
export function markHooks(hooks: Hook[], injections: ReadonlyArray<Ran>): MarkedHook[] {
  const marked: MarkedHook[] = hooks.map((h) => ({ ...h, injected: null, shared: false }))
  const others = new Map<string, MarkedHook>()
  const add = (h: MarkedHook, chars: number, index: number) => {
    h.injected = h.injected === null ? { count: 1, chars, index } : { count: h.injected.count + 1, chars: h.injected.chars + chars, index }
  }
  // Narrow `xs` by `keep`, unless that would leave none: a hint that rules out everything is no hint.
  const narrow = (xs: MarkedHook[], keep: (h: MarkedHook) => boolean) => (xs.some(keep) ? xs.filter(keep) : xs)
  injections.forEach((inj, index) => {
    const event = eventOf(inj.hookName)
    const target = inj.hookName.slice(event.length + 1)
    let found = inj.command === null ? [] : marked.filter((h) => h.command === inj.command && h.event === event)
    found = narrow(found, (h) => h.plugin === inj.plugin)
    // `PreToolUse:Grep` ran the hooks whose matcher meets `Grep`: one script
    // under nine matchers is one plugin's nine groups, not nine candidates.
    found = narrow(found, (h) => matches(h.matcher, target))
    const owners = [...new Set(found.map((h) => h.plugin ?? h.scope))]
    if (owners.length === 1) return add(found[0]!, inj.chars, index)
    for (const h of found) h.shared = true
    const plugin = owners.length > 1 ? owners.sort().join(' or ') : inj.plugin
    const key = JSON.stringify([plugin, event, inj.command ?? ''])
    let other = others.get(key)
    if (other === undefined) {
      other = { scope: 'other', plugin, event, matcher: null, command: inj.command ?? '', source: '', injected: null, shared: false }
      others.set(key, other)
    }
    add(other, inj.chars, index)
  })
  const chars = (h: MarkedHook) => h.injected?.chars ?? 0
  // byScope is stable, so sorting by characters first leaves them ordered inside each scope.
  return byScope([...marked, ...others.values()].sort((a, b) => chars(b) - chars(a)))
}

/**
 * Whether a hook's matcher selects `target` (a tool name, or SessionStart's
 * source): no matcher, an empty one or `*` selects everything, else it is
 * the regular expression Claude Code tests, whole. One that does not compile
 * is compared as a literal name.
 */
function matches(matcher: string | null, target: string): boolean {
  if (matcher === null || matcher === '' || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(target)
  } catch {
    return matcher === target
  }
}

/**
 * Invoked when the transcript names it, by name or by the file it ran from.
 * An invoked skill no directory explains (one built into Claude Code, a
 * plugin since removed) closes the list as `other`, as an unexplained
 * injection does, so the report never lists less than the run used.
 */
export function markSkills(skills: Skill[], invoked: ReadonlyArray<{ name: string; path: string }>): MarkedSkill[] {
  const names = new Set(invoked.map((s) => s.name))
  const paths = new Set(invoked.filter((s) => s.path !== '').map((s) => realPath(s.path)))
  const marked = skills.map((s) => ({ ...s, invoked: names.has(s.name) || paths.has(realPath(s.path)) }))
  const listed = new Set(skills.map((s) => s.name))
  const listedPaths = new Set(skills.map((s) => realPath(s.path)))
  const others = invoked
    .filter((s) => !listed.has(s.name) && !(s.path !== '' && listedPaths.has(realPath(s.path))))
    .map((s): MarkedSkill => ({ scope: 'other', plugin: null, name: s.name, path: s.path, invoked: true }))
  return [...marked, ...others]
}

export function inventoried(inv: Inventory, injections: ReadonlyArray<Ran>, invoked: ReadonlyArray<{ name: string; path: string }>): Inventoried {
  return { hooks: markHooks(inv.hooks, injections), skills: markSkills(inv.skills, invoked), agentMemory: inv.agentMemory }
}
