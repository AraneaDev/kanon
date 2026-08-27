import { expect, test } from 'bun:test'
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

async function run(args: string[], env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(['bun', CLI, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

function seeded() {
  const home = tmp('kanon-cli-')
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
  const home = tmp('kanon-cli-multi-')
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
  const home = tmp('kanon-cli-import-')
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

// --- brief: the session-start output Claude reads ----------------------------

test('brief names a foreign file as untrusted', async () => {
  const { home, repo } = seeded()
  const out = await run(['brief', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('FOREIGN  vendor/p/CLAUDE.md')
  expect(out).toContain("not the user's")
  expect(out).toContain('observed')
})

test('brief quotes the directive a foreign file carries', async () => {
  const { home, repo } = seeded()
  writeFileSync(join(repo, 'vendor', 'p', 'CLAUDE.md'), '# Rules\n\nDefault to using Bun instead of Node.js.\n')
  const out = await run(['brief', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('"Default to using Bun instead of Node.js."')
})

test('brief wrapped for a hook is a single valid systemMessage object', async () => {
  const { home, repo } = seeded()
  const out = await run(['brief', '--session', 's', '--cwd', repo, '--hook'], { KANON_HOME: home })
  const parsed = JSON.parse(out.trim()) as { systemMessage?: string }
  expect(typeof parsed.systemMessage).toBe('string')
  expect(parsed.systemMessage).toContain('FOREIGN  vendor/p/CLAUDE.md')
})

/**
 * The SessionStart case: nothing has been recorded for this session yet, so
 * the brief falls back to what Kanon expects rather than going silent the
 * way `alarm` does. Silence here would mean Claude never learns what governs
 * it, which is the whole point of the command.
 */
test('brief falls back to prediction when nothing is recorded yet', async () => {
  const home = tmp('kanon-brief-cold-')
  const repo = freshRepo(home)
  const out = await run(['brief', '--cwd', repo], { KANON_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'noclaude') })
  expect(out).toContain('(predicted)')
  expect(out).toContain('project  CLAUDE.md')
})

test('prediction never reports a file as missing', async () => {
  const home = tmp('kanon-brief-cold2-')
  const repo = freshRepo(home)
  const out = await run(['brief', '--cwd', repo], { KANON_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'noclaude') })
  expect(out).not.toContain('MISSING')
})

test('brief never exits non-zero and never prints a stack trace', async () => {
  const home = tmp('kanon-brief-broken-')
  const repo = freshRepo(home)
  const proc = Bun.spawn(['bun', CLI, 'brief', '--session', 'nope', '--cwd', repo, '--hook'], {
    env: { ...process.env, KANON_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  expect(code).toBe(0)
  expect(out).not.toContain('at ')
})

// --- the paths a hook or a mistyped command actually takes ------------------

interface Run {
  out: string
  err: string
  code: number
}

/** Like `run`, but keeps stderr and the exit code, which some paths are entirely about. */
async function runFull(args: string[], env: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(['bun', CLI, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { out, err, code }
}

/**
 * A repository with no ~/.claude of its own in play. `seeded` deliberately
 * leaves CLAUDE_CONFIG_DIR alone, which means the developer's real user-scope
 * rules become candidates; anything asserting on the *absence* of a row has
 * to shut that door first.
 */
function isolated(prefix: string) {
  const home = tmp(prefix)
  const repo = join(home, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const env = { KANON_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'no-claude-dir') }
  return { home, repo, env }
}

test('an unrecognised command prints usage rather than failing', async () => {
  const { home, repo } = seeded()
  const out = await run(['definitely-not-a-command', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('usage: kanon')
  expect(out).toContain('report|brief|alarm')
})

/**
 * The fallback matches a session file by the cwd recorded inside it. A log
 * whose lines yield no cwd -- unparseable, or wrapped with a null payload --
 * yields no root, and an unknown root must never count as a match. Kanon
 * says it has nothing rather than reaching for another repository's session.
 */
test('a session log with no usable cwd never matches the repository asking for it', async () => {
  const { home, repo, env } = isolated('kanon-cli-nocwd-')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, 's.jsonl'),
    ['this line is not json at all', JSON.stringify({ t: '', hook: 'unknown', raw: null, unparsed: 'x' })].join('\n') + '\n',
  )

  const out = await run(['report', '--cwd', repo], env)
  expect(out.toLowerCase()).toContain('no recorded session')
})

test('a session that recorded no loads reports nothing recorded rather than an empty section', async () => {
  const { home, repo, env } = isolated('kanon-cli-noloads-')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, 's.jsonl'),
    JSON.stringify({ t: '2026-08-27T06:58:00Z', hook: 'ConfigChange', raw: { cwd: repo, config_source: 'skills', changed_keys: ['a'] } }) + '\n',
  )

  const out = await run(['report', '--session', 's', '--cwd', repo], env)
  expect(out).toContain('nothing recorded')
  expect(out).toContain('CONFIG CHANGED')
  expect(out).toContain('06:58  skills  (+1)')
})

/**
 * The invariant from CLAUDE.md: an existing but empty log is an unobserved
 * session, not one where nothing governs you. Saying the latter would be a
 * confident lie, so the brief predicts instead.
 */
test('brief treats an existing but empty event log as unobserved and predicts instead', async () => {
  const { home, repo, env } = isolated('kanon-cli-emptylog-')
  writeFileSync(join(repo, 'CLAUDE.md'), '# Project\n')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, 's.jsonl'), '')

  const out = await run(['brief', '--session', 's', '--cwd', repo], env)
  expect(out).toContain('(predicted)')
  expect(out).toContain('project  CLAUDE.md')
})

test('alarm names a launch file that was expected and never loaded', async () => {
  const { home, repo } = seeded()
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'rules', 'testing.md'), '# Testing\n')

  const out = await run(['alarm', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('expected at launch but never loaded')
  expect(out).toContain('testing.md')
})

// --- the one place Kanon reads a file's content ------------------------------

/**
 * The quoted directive is meant to be the thing the file actually demands,
 * so the scaffolding above it -- front matter, a title -- is stepped over
 * rather than quoted back as if it were an instruction.
 */
test('the quoted directive steps over front matter and headings', async () => {
  const { home, repo } = seeded()
  writeFileSync(
    join(repo, 'vendor', 'p', 'CLAUDE.md'),
    '---\ntitle: Vendor rules\n---\n\n# Vendor rules\n\nRun phpstan before editing any PHP file.\n',
  )

  const out = await run(['brief', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('"Run phpstan before editing any PHP file."')
  expect(out).not.toContain('title: Vendor rules')
})

/** The brief is prepended to every session, so one file cannot be allowed to flood it. */
test('a very long directive is truncated rather than flooding the brief', async () => {
  const { home, repo } = seeded()
  const long = 'A'.repeat(400)
  writeFileSync(join(repo, 'vendor', 'p', 'CLAUDE.md'), `${long}\n`)

  const out = await run(['brief', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('...')
  expect(out).not.toContain(long)
  const quoted = out.split('\n').find((l) => l.trim().startsWith('"'))
  expect(quoted?.trim()).toBe(`"${'A'.repeat(117)}..."`)
})

test('a foreign file with nothing but headings is still named, just without a quote', async () => {
  const { home, repo } = seeded()
  writeFileSync(join(repo, 'vendor', 'p', 'CLAUDE.md'), '# Vendor\n\n## Rules\n')

  const out = await run(['brief', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('FOREIGN  vendor/p/CLAUDE.md')
  expect(out).not.toContain('"#')
})

// --- failing without taking the session with it -----------------------------

/**
 * The outer catch in cli.ts. A session log that cannot be read is a real
 * failure and says so on stderr with a non-zero exit, so a human running the
 * CLI notices -- but never as a stack trace, which is what a hook would
 * otherwise paste into a systemMessage.
 */
test('a session log that cannot be read fails on stderr with no stack trace', async () => {
  const { home, repo, env } = isolated('kanon-cli-unreadable-')
  // A directory where the log should be: existsSync passes, the read does not.
  mkdirSync(join(home, 'sessions', 's.jsonl'), { recursive: true })

  const { out, err, code } = await runFull(['report', '--session', 's', '--cwd', repo], env)
  expect(code).toBe(1)
  expect(out).toBe('')
  expect(err.trim().length).toBeGreaterThan(0)
  expect(err).not.toContain('\n    at ')
})

test('alarm fails silently on stdout so a hook can never paste an error into a systemMessage', async () => {
  const { home, repo, env } = isolated('kanon-cli-alarm-unreadable-')
  mkdirSync(join(home, 'sessions', 's.jsonl'), { recursive: true })

  const { out, code } = await runFull(['alarm', '--session', 's', '--cwd', repo, '--hook'], env)
  expect(code).toBe(1)
  expect(out).toBe('')
})

/** An empty --session is the shape `/kanon` passes when it has no id at all. */
test('an empty --session value falls back to the recorded session rather than looking for one named ""', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', '', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('FOREIGN')
})

/** With no --cwd at all the CLI reports on the process's own directory. */
test('report defaults to the process working directory when --cwd is omitted', async () => {
  const { home, repo } = seeded()
  const proc = Bun.spawn(['bun', CLI, 'report', '--session', 's'], {
    cwd: repo,
    env: { ...process.env, KANON_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  expect(out).toContain('FOREIGN')
})

/** Housekeeping runs before reporting and must never be what stops it. */
test('report still prints when the records directory cannot be pruned', async () => {
  const { home, repo } = seeded()
  // A file where prune expects the reports directory: it steps over this.
  writeFileSync(join(home, 'reports'), 'not a directory\n')

  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('LOADED')
  expect(out).toContain('FOREIGN')
})

test('an old session log is pruned on the next run', async () => {
  const { home, repo, env } = isolated('kanon-cli-prune-')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const stale = join(sessions, 'ancient.jsonl')
  writeFileSync(stale, '{}\n')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(stale, longAgo, longAgo)

  await run(['report', '--cwd', repo], env)
  expect(readdirSync(sessions)).not.toContain('ancient.jsonl')
})

// --- colour is a property of the terminal, never of the report ---------------

/**
 * The gate that matters. `/kanon` runs this through Claude Code's Bash tool,
 * so stdout is a pipe and the text is on its way into a model's context --
 * where escape codes cost tokens and come back out as literal garbage rather
 * than colour. Every test above this one already depends on it silently;
 * this one says so.
 */
test('report piped to a non-terminal carries no escape codes', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).not.toContain('\x1b')
})

test('FORCE_COLOR colours the printed report', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home, FORCE_COLOR: '1' })
  expect(out).toContain('\x1b[')
  expect(out).toContain('\x1b[1;31mFOREIGN')
})

test('NO_COLOR beats FORCE_COLOR at the CLI too', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home, FORCE_COLOR: '1', NO_COLOR: '1' })
  expect(out).not.toContain('\x1b')
})

/**
 * The persisted report outlives the terminal that produced it and is read
 * back by whatever the user points at it, so colour must never reach the
 * file -- not even on the run that printed it in colour.
 */
test('the report written to disk stays plain even when the printed one is coloured', async () => {
  const { home, repo } = seeded()
  const printed = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home, FORCE_COLOR: '1' })
  const written = await Bun.file(join(home, 'reports', 's.txt')).text()

  expect(printed).toContain('\x1b[')
  expect(written).not.toContain('\x1b')
  // eslint-disable-next-line no-control-regex
  expect(printed.replace(/\x1b\[[0-9;]*m/g, '')).toBe(written)
})

test('brief is never coloured, because its reader is a model', async () => {
  const { home, repo } = seeded()
  const out = await run(['brief', '--session', 's', '--cwd', repo], { KANON_HOME: home, FORCE_COLOR: '1' })
  expect(out).not.toContain('\x1b')
})

test('alarm is never coloured', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--session', 's', '--cwd', repo], { KANON_HOME: home, FORCE_COLOR: '1' })
  expect(out).not.toContain('\x1b')
})

// --- the brief has to reach the reader it was written for --------------------

/**
 * `systemMessage` is documented as "Plain-text message shown in the
 * transcript. Not added to Claude's context; Claude never sees it." The brief
 * exists to tell Claude which of the instructions it is holding are not the
 * user's, and it closes by asking Claude to raise anything alarming -- both
 * addressed to a reader that channel never reaches.
 * `hookSpecificOutput.additionalContext` is the SessionStart channel that
 * does, so the payload carries both and the user keeps the visible line.
 */
test('brief --hook reaches Claude through additionalContext, not only the transcript', async () => {
  const { home, repo } = seeded()
  const out = await run(['brief', '--session', 's', '--cwd', repo, '--hook'], { KANON_HOME: home })
  const parsed = JSON.parse(out.trim()) as {
    systemMessage?: string
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
  }

  expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart')
  expect(parsed.hookSpecificOutput?.additionalContext).toContain('FOREIGN  vendor/p/CLAUDE.md')
  expect(parsed.systemMessage).toContain('FOREIGN  vendor/p/CLAUDE.md')
})

/**
 * One brief, two channels. A payload that told the user one thing and Claude
 * another would be exactly the kind of split this tool exists to catch.
 */
test('both channels carry the same brief, character for character', async () => {
  const { home, repo } = seeded()
  const out = await run(['brief', '--session', 's', '--cwd', repo, '--hook'], { KANON_HOME: home })
  const parsed = JSON.parse(out.trim()) as {
    systemMessage: string
    hookSpecificOutput: { additionalContext: string }
  }
  expect(parsed.hookSpecificOutput.additionalContext).toBe(parsed.systemMessage)
})

test('the hook payload is a single line of valid JSON a shell script can print verbatim', async () => {
  const { home, repo } = seeded()
  const out = await run(['brief', '--session', 's', '--cwd', repo, '--hook'], { KANON_HOME: home })
  expect(out.trim().split('\n')).toHaveLength(1)
  expect(() => JSON.parse(out.trim())).not.toThrow()
})
