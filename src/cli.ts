#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discover } from './discover'
import { resolveImports } from './discover/imports'
import { normalise } from './normalise'
import { sessionRoot } from './origin'
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

interface SessionFile {
  id: string
  path: string
  mtimeMs: number
}

function sessionFiles(): SessionFile[] {
  const dir = join(kanonHome(), 'sessions')
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: SessionFile[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    out.push({ id: name.slice(0, -'.jsonl'.length), path, mtimeMs })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * The session root a recorded session file belongs to, read from the `cwd`
 * every Claude Code hook payload carries (present on `raw.cwd`, since the
 * Recorder wraps the payload verbatim -- see the task 1 payload spike).
 * Undefined when no line yields a usable cwd (an empty log, or one that's
 * entirely unparsed): an unknown root must never be treated as a match,
 * only ever as "keep looking".
 */
function recordedRoot(path: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const raw = (parsed as { raw?: unknown }).raw
    const cwd = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).cwd : undefined
    if (typeof cwd === 'string' && cwd.length > 0) return sessionRoot(cwd)
  }
  return undefined
}

/**
 * Claude Code does not expose the running session's own id to a slash
 * command or the Bash tool (as of this ruleset there is no
 * `CLAUDE_SESSION_ID` in that environment; hooks get it separately, on
 * their stdin JSON, which is how the Recorder and the two session hooks
 * get theirs). `/kanon` therefore has no id to pass, so an omitted or
 * empty `--session` falls back to a recorded session file instead.
 *
 * Picking merely the most recently written file is not safe: with two
 * Claude Code sessions open in two different repositories, the newer file
 * belongs to whichever session last recorded an event, which has nothing
 * to do with which repository `/kanon` is being run from. Handing repo A's
 * report repo B's events doesn't just name the wrong session, it fabricates
 * a FOREIGN alarm on repo B's own legitimate file and reports repo A's real
 * CLAUDE.md as missing -- a false alarm is worse than none, so the fallback
 * is scoped to the session root: newest file first, first one whose
 * recorded root matches `cwd`'s root wins. A session file with no
 * discoverable root never matches, and if nothing matches, there is no
 * fallback at all -- never a session from a different repository.
 */
function latestSessionFor(cwd: string): string | undefined {
  const targetRoot = sessionRoot(cwd)
  for (const f of sessionFiles()) {
    if (recordedRoot(f.path) === targetRoot) return f.id
  }
  return undefined
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
  const cwd = arg('cwd') ?? process.cwd()
  const sessionArg = arg('session')
  const session = sessionArg && sessionArg.length > 0 ? sessionArg : latestSessionFor(cwd)

  if (command === 'report') {
    if (!session) {
      // Never fall back to a session from a different repository: say
      // plainly that there's nothing recorded here rather than guess.
      console.log(`kanon: no recorded session found for ${cwd}`)
      return
    }
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
    // say unprompted -- and with no matching session at all, there is no
    // log to derive them from.
    if (!session || !existsSync(sessionFile(session))) return
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
