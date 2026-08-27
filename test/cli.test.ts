import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
  // Real hook payloads always carry `cwd` alongside `session_id` (see the
  // task 1 payload spike); fixtures include it too so the --cwd-aware
  // fallback can find this session by the root it was actually recorded in.
  const wrap = (f: string, reason: string) =>
    JSON.stringify({ t: '2026-08-27T00:00:00Z', hook: 'InstructionsLoaded', raw: { session_id: 's', hook_event_name: 'InstructionsLoaded', cwd: repo, file_path: f, load_reason: reason } })
  writeFileSync(join(sessions, 's.jsonl'), [wrap(join(repo, 'CLAUDE.md'), 'session_start'), wrap(join(repo, 'vendor', 'p', 'CLAUDE.md'), 'nested_traversal')].join('\n') + '\n')
  return { home, repo }
}

/**
 * Two separate repositories recording into the same ~/.kanon, with repo B's
 * session file made strictly newer than repo A's. A fallback that picks
 * "the newest session file" without checking which repository it was
 * recorded in would hand repo A's `/kanon` run repo B's events.
 */
function twoRepos() {
  const home = mkdtempSync(join(tmpdir(), 'kanon-cli-multi-'))
  const repoA = join(home, 'repoA')
  const repoB = join(home, 'repoB')
  mkdirSync(join(repoA, '.git'), { recursive: true })
  mkdirSync(join(repoB, '.git'), { recursive: true })
  mkdirSync(join(repoB, 'vendor', 'p'), { recursive: true })
  writeFileSync(join(repoA, 'CLAUDE.md'), '')
  writeFileSync(join(repoB, 'CLAUDE.md'), '')
  writeFileSync(join(repoB, 'vendor', 'p', 'CLAUDE.md'), '')

  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const wrap = (cwd: string, f: string, reason: string) =>
    JSON.stringify({ t: '2026-08-27T00:00:00Z', hook: 'InstructionsLoaded', raw: { session_id: 'x', hook_event_name: 'InstructionsLoaded', cwd, file_path: f, load_reason: reason } })

  writeFileSync(join(sessions, 'a.jsonl'), wrap(repoA, join(repoA, 'CLAUDE.md'), 'session_start') + '\n')
  writeFileSync(
    join(sessions, 'b.jsonl'),
    [wrap(repoB, join(repoB, 'CLAUDE.md'), 'session_start'), wrap(repoB, join(repoB, 'vendor', 'p', 'CLAUDE.md'), 'nested_traversal')].join('\n') + '\n',
  )

  const past = new Date(Date.now() - 60_000)
  utimesSync(join(sessions, 'a.jsonl'), past, past)

  return { home, repoA, repoB }
}

/**
 * A CLAUDE.md that @-imports a second file, with both files recorded as
 * loaded. Regression fixture for Finding 1: discover() must hand cli.ts the
 * import map it already computed internally, not have cli.ts re-run
 * resolveImports over the merged launch candidates (which always finds
 * nothing, since resolveImports skips its own seeds and every import target
 * is already promoted to a launch candidate by the time cli.ts sees it).
 */
function seededWithImport() {
  const home = mkdtempSync(join(tmpdir(), 'kanon-cli-import-'))
  const repo = join(home, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), 'see @docs/extra.md\n')
  writeFileSync(join(repo, 'docs', 'extra.md'), '# Extra\n')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const wrap = (f: string, reason: string) =>
    JSON.stringify({ t: '2026-08-27T00:00:00Z', hook: 'InstructionsLoaded', raw: { session_id: 's', hook_event_name: 'InstructionsLoaded', cwd: repo, file_path: f, load_reason: reason } })
  writeFileSync(
    join(sessions, 's.jsonl'),
    [wrap(join(repo, 'CLAUDE.md'), 'session_start'), wrap(join(repo, 'docs', 'extra.md'), 'session_start')].join('\n') + '\n',
  )
  return { home, repo }
}

test('report shows an @-imported file annotated with the file that imported it (Finding 1 regression)', async () => {
  const { home, repo } = seededWithImport()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('extra.md')
  expect(out).toContain('imported by')
})

function freshRepo(home: string) {
  const repo = join(home, 'repoC')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), '')
  return repo
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
  expect(readdirSync(reportsDir)).toEqual(['s.txt'])
})

test('the --session fallback is scoped to --cwd: repo A never gets repo B\'s newer session', async () => {
  const { home, repoA } = twoRepos()
  const out = await run(['report', '--cwd', repoA], { KANON_HOME: home })
  // Repo A's own file loaded, nothing foreign, nothing from repo B.
  expect(out).toContain('project')
  expect(out).toContain('CLAUDE.md')
  expect(out).not.toContain('FOREIGN')
  expect(out).not.toContain('repoB')
})

test('the --session fallback still finds repo B when --cwd points there', async () => {
  const { home, repoB } = twoRepos()
  const out = await run(['report', '--cwd', repoB], { KANON_HOME: home })
  expect(out).toContain('FOREIGN')
})

test('report prints a plain no-session message for a repo with nothing recorded, never another repo\'s data', async () => {
  const { home } = twoRepos()
  const repoC = freshRepo(home)
  const out = await run(['report', '--cwd', repoC], { KANON_HOME: home })
  expect(out.toLowerCase()).toContain('no recorded session')
  expect(out).not.toContain('FOREIGN')
  expect(out).not.toContain('repoA')
  expect(out).not.toContain('repoB')
})

test('alarm is silent for a repo with nothing recorded, even while another repo has a live session', async () => {
  const { home } = twoRepos()
  const repoC = freshRepo(home)
  const out = await run(['alarm', '--cwd', repoC], { KANON_HOME: home })
  expect(out.trim()).toBe('')
})

test('a failed atomic rename cleans up its temp file and leaves the target untouched', async () => {
  const { home, repo } = seeded()
  const dir = join(home, 'reports')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 's.txt')
  // Force renameSync(tmp, target) to fail by making the destination itself
  // a (non-empty) directory: a file can never be renamed onto that.
  mkdirSync(join(target, 'occupied'), { recursive: true })

  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('LOADED')

  expect(statSync(target).isDirectory()).toBe(true)
  expect(readdirSync(target)).toEqual(['occupied'])
  expect(readdirSync(dir).some((n) => n.includes('.tmp'))).toBe(false)
})
