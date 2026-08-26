import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'hooks', 'scripts', 'record.sh')

async function record(payload: string, home: string): Promise<void> {
  const proc = Bun.spawn(['sh', SCRIPT], {
    stdin: new TextEncoder().encode(payload),
    env: { ...process.env, KANON_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  expect(proc.exitCode).toBe(0)
}

test('appends a wrapped payload to the session log', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-'))
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'InstructionsLoaded',
    cwd: '/root/aranea',
    file_path: '/root/aranea/CLAUDE.md',
    load_reason: 'session_start',
  })
  await record(payload, home)

  const file = join(home, 'sessions', 'abc123.jsonl')
  expect(existsSync(file)).toBe(true)
  const line = JSON.parse(readFileSync(file, 'utf8').trim())
  expect(line.hook).toBe('InstructionsLoaded')
  expect(line.raw.file_path).toBe('/root/aranea/CLAUDE.md')
  expect(line.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('a non-JSON payload lands in unknown.jsonl as valid JSON with unparsed field', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-'))
  await record('not json at all', home)
  const file = join(home, 'sessions', 'unknown.jsonl')
  expect(existsSync(file)).toBe(true)
  const line = JSON.parse(readFileSync(file, 'utf8').trim())
  expect(line.hook).toBe('unknown')
  expect(line.raw).toBe(null)
  expect(line.unparsed).toBe('not json at all')
})

test('non-JSON with quotes and backslashes round-trips intact', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-'))
  const payload = 'test "quote" and \\backslash'
  await record(payload, home)
  const file = join(home, 'sessions', 'unknown.jsonl')
  const line = JSON.parse(readFileSync(file, 'utf8').trim())
  expect(line.unparsed).toBe(payload)
})

test('appends rather than truncating', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-'))
  const one = JSON.stringify({ session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: '/a' })
  const two = JSON.stringify({ session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: '/b' })
  await record(one, home)
  await record(two, home)
  const lines = readFileSync(join(home, 'sessions', 's.jsonl'), 'utf8').trim().split('\n')
  expect(lines.length).toBe(2)
})
