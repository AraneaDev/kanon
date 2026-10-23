import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownerOf, pluginIndex } from '../src/attribution'
import { tmp } from './tmp'

function plugin(cache: string, market: string, name: string, version: string, body: string): void {
  const dir = join(cache, market, name, version, 'hooks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hooks.json'), body)
}

const hooks = (...commands: string[]): string =>
  JSON.stringify({
    hooks: { SessionStart: [{ hooks: commands.map((command) => ({ type: 'command', command })) }] },
  })

describe('pluginIndex / ownerOf', () => {
  test('an unexpanded plugin-root command resolves through the index', () => {
    const cache = tmp('kanon-attr-')
    const cmd = '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start'
    plugin(cache, 'market', 'example-plugin', '1.0.0', hooks(cmd))
    expect(ownerOf(cmd, pluginIndex(cache))).toBe('example-plugin')
  })

  test('an absolute cache path resolves by path', () => {
    const cmd = '/home/user/.claude/plugins/cache/example-market/example-plugin/1.0.169/hooks/x.mjs'
    expect(ownerOf(cmd, new Map())).toBe('example-plugin')
  })

  test('an unknown or null command is unattributed', () => {
    expect(ownerOf('echo hi', new Map())).toBe('unattributed')
    expect(ownerOf(null, new Map())).toBe('unattributed')
  })

  test('a malformed hooks.json is skipped, not thrown', () => {
    const cache = tmp('kanon-attr-')
    plugin(cache, 'm', 'broken', '1', '{not json')
    plugin(cache, 'm', 'odd', '1', JSON.stringify({ hooks: 'nope' }))
    plugin(cache, 'm', 'good', '1', hooks('run-good'))
    const index = pluginIndex(cache)
    expect(index.get('run-good')).toBe('good')
    expect(index.size).toBe(1)
  })

  test('a missing cache directory yields an empty index', () => {
    expect(pluginIndex(join(tmp('kanon-attr-'), 'absent')).size).toBe(0)
  })

  test('two versions of one plugin index to the same name', () => {
    const cache = tmp('kanon-attr-')
    plugin(cache, 'm', 'multi', '1.0.0', hooks('run-old'))
    plugin(cache, 'm', 'multi', '2.0.0', hooks('run-new'))
    const index = pluginIndex(cache)
    expect(ownerOf('run-old', index)).toBe('multi')
    expect(ownerOf('run-new', index)).toBe('multi')
  })

  test('a symlinked entry is not followed', () => {
    const cache = tmp('kanon-attr-')
    const outside = tmp('kanon-attr-out-')
    plugin(outside, 'm', 'linked', '1', hooks('run-linked'))
    symlinkSync(join(outside, 'm'), join(cache, 'm'))
    expect(pluginIndex(cache).size).toBe(0)
  })

  test('a command shipped by two different plugins is unattributed', () => {
    const cache = tmp('kanon-attr-')
    const cmd = '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start'
    plugin(cache, 'm', 'first-plugin', '1', hooks(cmd))
    plugin(cache, 'm', 'second-plugin', '1', hooks(cmd))
    expect(ownerOf(cmd, pluginIndex(cache))).toBe('unattributed')
  })

  test('a hooks.json that is itself a symlink is not read', () => {
    const cache = tmp('kanon-attr-')
    const outside = tmp('kanon-attr-out-')
    writeFileSync(join(outside, 'hooks.json'), hooks('run-linked'))
    const dir = join(cache, 'm', 'p', '1', 'hooks')
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(outside, 'hooks.json'), join(dir, 'hooks.json'))
    expect(pluginIndex(cache).size).toBe(0)
  })
})
