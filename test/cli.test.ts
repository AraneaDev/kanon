import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

async function run(args: string[], env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(['bun', CLI, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

function seeded() {
  const home = mkdtempSync(join(tmpdir(), 'kanon-cli-'))
  const repo = join(home, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'vendor', 'p'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), '')
  writeFileSync(join(repo, 'vendor', 'p', 'CLAUDE.md'), '')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const wrap = (f: string, reason: string) =>
    JSON.stringify({ t: '2026-08-27T00:00:00Z', hook: 'InstructionsLoaded', raw: { session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: f, load_reason: reason } })
  writeFileSync(join(sessions, 's.jsonl'), [wrap(join(repo, 'CLAUDE.md'), 'session_start'), wrap(join(repo, 'vendor', 'p', 'CLAUDE.md'), 'nested_traversal')].join('\n') + '\n')
  return { home, repo }
}

test('report prints the loaded set', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('LOADED')
  expect(out).toContain('CLAUDE.md')
})

test('report flags the vendored file as foreign', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('FOREIGN')
})

test('alarm speaks when a foreign file loaded', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out.trim().length).toBeGreaterThan(0)
  expect(out).toContain('foreign')
})

test('alarm is silent for an unknown session', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--session', 'nope', '--cwd', repo], { KANON_HOME: home })
  expect(out.trim()).toBe('')
})

test('alarm --hook emits ready-made systemMessage JSON', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--session', 's', '--cwd', repo, '--hook'], { KANON_HOME: home })
  const parsed = JSON.parse(out.trim())
  expect(typeof parsed.systemMessage).toBe('string')
  expect(parsed.systemMessage).toContain('foreign')
})

test('alarm --hook is silent for an unknown session', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--session', 'nope', '--cwd', repo, '--hook'], { KANON_HOME: home })
  expect(out.trim()).toBe('')
})

test('report falls back to the most recently written session when --session is omitted', async () => {
  // Claude Code does not expose a running session's own id to the Bash
  // tool or a slash command, so `/kanon` cannot pass --session at all.
  const { home, repo } = seeded()
  const out = await run(['report', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('FOREIGN')
})

test('alarm falls back to the most recently written session when --session is omitted', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('foreign')
})

test('report writes the same text to disk that it prints, with no leftover temp file', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  const reportsDir = join(home, 'reports')
  const written = await Bun.file(join(reportsDir, 's.txt')).text()
  expect(written).toBe(out)
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(reportsDir)).toEqual(['s.txt'])
})
