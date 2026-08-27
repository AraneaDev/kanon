#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discover } from './discover'
import { resolveImports } from './discover/imports'
import { normalise } from './normalise'
import { render } from './render'
import { buildReport } from './report'
import type { Report } from './types'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function kanonHome(): string {
  return process.env.KANON_HOME ?? join(homedir(), '.kanon')
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

function sessionFile(session: string): string {
  return join(kanonHome(), 'sessions', `${session}.jsonl`)
}

/**
 * Claude Code does not expose the running session's own id to a slash
 * command or the Bash tool (as of this ruleset there is no
 * `CLAUDE_SESSION_ID` in that environment; hooks get it separately, on
 * their stdin JSON, which is how the Recorder and the two session hooks
 * get theirs). `/kanon` therefore has no id to pass, so an omitted or
 * empty `--session` falls back to whichever session file under
 * `sessions/` was written to most recently -- in practice the session the
 * user is sitting in, since its InstructionsLoaded/ConfigChange events
 * keep touching that file for the session's whole lifetime. This is a
 * heuristic, not a guarantee: two Claude Code sessions active on the same
 * machine at the same moment can race it.
 */
function latestSession(): string | undefined {
  const dir = join(kanonHome(), 'sessions')
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  let best: { id: string; mtimeMs: number } | undefined
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    let mtimeMs: number
    try {
      mtimeMs = statSync(join(dir, name)).mtimeMs
    } catch {
      continue
    }
    if (!best || mtimeMs > best.mtimeMs) best = { id: name.slice(0, -'.jsonl'.length), mtimeMs }
  }
  return best?.id
}

function collect(session: string, cwd: string): Report {
  const file = sessionFile(session)
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const events = normalise(lines)

  const home = claudeHome()
  const { root, candidates } = discover(cwd, home)
  const launch = candidates.filter((c) => c.label === 'launch').map((c) => c.path)
  const importedBy = resolveImports(launch)

  return buildReport(events, candidates, root, home, importedBy)
}

/**
 * Write text to `path` without ever leaving a truncated file behind. A
 * direct writeFileSync can be interrupted mid-write by the process being
 * killed (SessionEnd's declared timeout is exactly this kind of kill), which
 * would replace a good report with a corrupt one. Writing to a sibling
 * temp file and renaming into place is atomic on the same filesystem: the
 * final path is always either the previous report or the complete new one,
 * matching the spec's "leaves the raw event log in place rather than a
 * partial report" requirement.
 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Best effort cleanup; a stray temp file is swept by prune (Task 10).
    }
    throw err
  }
}

function alarmLines(report: Report): string[] {
  const lines: string[] = []
  for (const c of report.loaded) {
    if (c.origin === 'foreign') lines.push(`kanon: foreign instruction file loaded: ${c.path}`)
  }
  for (const c of report.missing) lines.push(`kanon: expected at launch but never loaded: ${c.path}`)
  return lines
}

function main(): void {
  const command = process.argv[2] ?? 'report'
  const sessionArg = arg('session')
  const session = sessionArg && sessionArg.length > 0 ? sessionArg : latestSession() ?? 'unknown'
  const cwd = arg('cwd') ?? process.cwd()

  if (command === 'report') {
    const report = collect(session, cwd)
    const text = render(report)
    console.log(text)
    try {
      const dir = join(kanonHome(), 'reports')
      mkdirSync(dir, { recursive: true })
      writeAtomic(join(dir, `${session}.txt`), `${text}\n`)
    } catch {
      // A report that cannot be persisted was still printed. SessionEnd's
      // own budget, not a write failure here, is what the spec asks us to
      // survive without corrupting the file that's already there.
    }
    return
  }

  if (command === 'alarm') {
    // Silence isn't just "nothing to report", it's also "no evidence to
    // report from". A session with no recorded events at all is almost
    // always a session Kanon hasn't observed (not yet started, or a
    // recording hook that never fired), not one where every launch
    // candidate genuinely failed to load. Only `missing`/`foreign` derived
    // from an existing, if possibly empty, event log are honest enough to
    // say unprompted.
    if (!existsSync(sessionFile(session))) return
    const report = collect(session, cwd)
    const text = alarmLines(report).join('\n')
    if (text.length === 0) return
    // --hook makes the CLI emit the ready-made JSON a hook can print
    // verbatim, so the calling shell script never has to escape a string
    // itself: JSON.stringify is exact, unlike ad hoc sed/printf escaping.
    console.log(flag('hook') ? JSON.stringify({ systemMessage: text }) : text)
    return
  }

  console.log('usage: kanon [report|alarm] [--session <id>] [--cwd <path>] [--hook]')
}

try {
  main()
} catch (err) {
  // The recorder must never fail a session; the same now holds for the two
  // cold-path commands. `alarm` in particular must fail silently: an
  // uncaught error here must never leak a stack trace into a systemMessage,
  // so both commands print nothing further and exit non-zero for humans
  // running the CLI directly to notice.
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
