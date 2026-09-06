import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp'

const SCRIPT = join(import.meta.dir, '..', 'hooks', 'scripts', 'turn.sh')
const PLUGIN_ROOT = join(import.meta.dir, '..')

async function turn(payload: string, home: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['sh', SCRIPT], {
    stdin: new TextEncoder().encode(payload),
    env: { ...process.env, KANON_HOME: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  return { code: await proc.exited, out }
}

test('exits 0 and says nothing on an empty payload', async () => {
  const r = await turn('', tmp('kanon-turn-'))
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('')
})

test('exits 0 on garbage', async () => {
  const r = await turn('not json at all', tmp('kanon-turn-'))
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('')
})

test('exits 0 when there is no session log for this id', async () => {
  const r = await turn(JSON.stringify({ session_id: 'abc', cwd: '/repo' }), tmp('kanon-turn-'))
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('')
})

/**
 * The guard is the whole reason this hook is safe to run on every prompt.
 * A watermark that already matches the log must not start Bun at all.
 */
test('is silent when the watermark already matches the log', async () => {
  const home = tmp('kanon-turn-')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'abc.jsonl'), '{"t":"","hook":"x","raw":{}}\n')
  writeFileSync(join(home, 'state', 'abc.turn'), '1\n')
  const r = await turn(JSON.stringify({ session_id: 'abc', cwd: '/repo' }), home)
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('')
})

/**
 * A session id is used to build a path, so it can never be allowed to
 * contain a traversal. record.sh applies the same guard for the same reason.
 */
test('refuses a session id that could escape the state directory', async () => {
  const r = await turn(JSON.stringify({ session_id: '../escape', cwd: '/repo' }), tmp('kanon-turn-'))
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('')
})
