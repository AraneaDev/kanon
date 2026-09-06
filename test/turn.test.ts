import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

/**
 * A fake `bun` on a directory prepended to PATH, so tests can tell whether
 * the script actually reached `command -v bun` / the final `bun ...` line,
 * rather than just observing empty stdout — which a script that dies for an
 * unrelated reason would also produce. `command -v bun` and the shell both
 * search PATH left to right, so putting this directory first shadows the
 * real interpreter for the duration of one spawn only.
 */
function fakeBun(): { dir: string; sentinel: string } {
  const dir = tmp('kanon-turn-fakebin-')
  const sentinel = join(dir, 'bun-called')
  writeFileSync(join(dir, 'bun'), `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`)
  chmodSync(join(dir, 'bun'), 0o755)
  return { dir, sentinel }
}

async function turnWithFakeBun(
  payload: string,
  home: string,
): Promise<{ code: number; out: string; calledBun: boolean }> {
  const { dir, sentinel } = fakeBun()
  const proc = Bun.spawn(['sh', SCRIPT], {
    stdin: new TextEncoder().encode(payload),
    env: { ...process.env, KANON_HOME: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, PATH: `${dir}:${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { code, out, calledBun: existsSync(sentinel) }
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
 *
 * Empty stdout alone does not prove that: the real `notice` command would
 * also print nothing for this fixture's non-instruction log line, whether
 * or not it was ever invoked. The fake `bun` sentinel is what tells the two
 * apart — it is only left behind if the script actually reached `bun`.
 */
test('is silent when the watermark already matches the log, and never reaches bun', async () => {
  const home = tmp('kanon-turn-')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'abc.jsonl'), '{"t":"","hook":"x","raw":{}}\n')
  writeFileSync(join(home, 'state', 'abc.turn'), '1\n')
  const r = await turnWithFakeBun(JSON.stringify({ session_id: 'abc', cwd: '/repo' }), home)
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('')
  expect(r.calledBun).toBe(false)
})

/**
 * The positive control for the test above: with the watermark stale, the
 * exact same fixture must reach bun. Without this, a script that always
 * exits before `command -v bun` (bypassing the guard entirely, in either
 * direction) could still pass the silent case above by accident.
 */
test('calls bun when the log has grown past the watermark', async () => {
  const home = tmp('kanon-turn-')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'abc.jsonl'), '{"t":"","hook":"x","raw":{}}\n')
  writeFileSync(join(home, 'state', 'abc.turn'), '0\n')
  const r = await turnWithFakeBun(JSON.stringify({ session_id: 'abc', cwd: '/repo' }), home)
  expect(r.code).toBe(0)
  expect(r.calledBun).toBe(true)
})

/**
 * A session id is used to build a path, so it can never be allowed to
 * contain a traversal. record.sh applies the same guard for the same reason.
 *
 * "../escape" resolves under `$home/sessions/../escape.jsonl`, i.e.
 * `$home/escape.jsonl`. That file is planted here on purpose: without it,
 * the unguarded script would already bail at "no such log file" for a
 * reason that has nothing to do with the traversal guard, and this test
 * would pass whether or not the guard exists. Planting the file, and
 * checking the fake-bun sentinel rather than only stdout, is what makes the
 * guard's absence actually observable.
 */
test('refuses a session id that could escape the sessions directory', async () => {
  const home = tmp('kanon-turn-')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'escape.jsonl'), '{"t":"","hook":"x","raw":{}}\n')
  const r = await turnWithFakeBun(JSON.stringify({ session_id: '../escape', cwd: '/repo' }), home)
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('')
  expect(r.calledBun).toBe(false)
})
