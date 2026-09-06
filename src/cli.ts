#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeAtomic } from './atomic'
import { brief, type BriefInput } from './brief'
import { COLOUR, colourEnabled } from './colour'
import { discover } from './discover'
import { diff, digest, SNAPSHOT_VERSION } from './drift'
import { prune, tooLarge } from './limits'
import { normalise } from './normalise'
import { BRIEFED_REASONS, notice } from './notice'
import { classify, sessionRoot } from './origin'
import { realPath } from './paths'
import { render } from './render'
import { buildReport } from './report'
import { readSnapshot, readWatermark, writeSnapshot, writeWatermark } from './state'
import type { Classified, Report } from './types'

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
    const recorded = recordedRoot(f.path)
    if (recorded !== undefined && recorded === targetRoot) return f.id
  }
  return undefined
}

function collect(session: string, cwd: string): Report {
  const file = sessionFile(session)
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const events = normalise(lines)

  const home = claudeHome()
  const { root, candidates, skipped, importedBy } = discover(cwd, home)
  const previous = readSnapshot(kanonHome(), root)

  return buildReport(events, candidates, root, home, importedBy, skipped, previous?.files ?? null)
}

/**
 * The first line of a file that reads like a directive rather than
 * scaffolding. Headings, front-matter fences and blank lines are skipped;
 * everything else is taken as-is.
 *
 * This is the one place Kanon looks at an instruction file's *content*
 * rather than its provenance, and it is deliberately shallow: enough to let
 * Claude match a foreign file against the directives already merged into its
 * context, and nothing that could be mistaken for judging what the file
 * says. Kanon still does not score, rank, or scan these files.
 */
function firstDirective(path: string): string | null {
  if (tooLarge(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let inFrontMatter = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('---')) {
      inFrontMatter = !inFrontMatter
      continue
    }
    if (inFrontMatter || line.startsWith('#')) continue
    return line.length > 120 ? `${line.slice(0, 117)}...` : line
  }
  return null
}

/**
 * What the brief should say when Kanon has no events for this session.
 *
 * SessionStart may fire before the first InstructionsLoaded is recorded, so
 * going silent (the way `alarm` does) would mean Claude usually learns
 * nothing at all. Layer two needs no events: `discover` inspects the
 * filesystem and predicts the launch set, and each prediction is classified
 * exactly as a real load would be.
 */
function predictedFiles(cwd: string, home: string, root: string): Classified[] {
  const { candidates } = discover(cwd, home)
  return candidates
    .filter((c) => c.label === 'launch')
    .map((c) => ({
      path: c.path,
      origin: classify(c.path, root, home),
      reason: 'expected at launch',
      viaImport: null,
      gitIgnored: null,
      gitTracked: null,
    }))
}

function briefInput(session: string | undefined, cwd: string): BriefInput {
  const home = claudeHome()
  const root = sessionRoot(cwd)
  const hasEvents = session !== undefined && existsSync(sessionFile(session))
  const previous = readSnapshot(kanonHome(), root)?.files ?? null

  const predicted = (): BriefInput => {
    const files = predictedFiles(cwd, home, root)
    const drift = previous === null ? null : diff(previous, digest(files), existsSync)
    return {
      root,
      basis: 'predicted',
      files,
      missing: [],
      drift,
    }
  }

  if (!hasEvents) return predicted()

  let report: Report
  try {
    report = collect(session, cwd)
  } catch {
    // The log exists and still cannot be read: a directory sitting where the
    // file should be, a permissions error, a truncated mount. That is no more
    // evidence about this session than having no log at all, and `brief` is
    // the one command that must always speak, so it predicts rather than
    // going silent. `report` and `alarm` deliberately do not do this: a
    // report that cannot be produced should say so loudly, and an alarm with
    // no evidence behind it should say nothing.
    return predicted()
  }
  // An existing but empty log is still an unobserved session: the file can
  // be created by a hook that recorded nothing usable. Reporting "no
  // instruction files govern you" there would be a confident lie, so it
  // falls back to prediction like any other unrecorded session.
  if (report.loaded.length === 0) {
    return predicted()
  }
  // report.drift already came out of buildReport's own diff() call, so it is
  // forwarded as-is rather than recomputed here.
  return {
    root: report.root,
    basis: 'observed',
    files: report.loaded,
    missing: report.missing,
    drift: report.drift,
  }
}

/**
 * The SessionStart payload for the brief, addressed to both of its readers.
 *
 * `systemMessage` is shown in the transcript and, per Claude Code's hook
 * contract, is explicitly *not* added to Claude's context -- "Claude never
 * sees it". The brief exists to calibrate Claude's trust in instructions it
 * holds with no attribution, and it closes by asking Claude to raise anything
 * alarming with the user; on that channel alone, both were addressed to a
 * reader that never received them. `hookSpecificOutput.additionalContext` is
 * the SessionStart channel that does reach the model.
 *
 * Both are emitted rather than one: the user keeps the visible line in the
 * transcript, and Claude gets the text that was written for it. The two carry
 * the same string on purpose -- a brief that said different things to the two
 * readers would be the one bug this tool exists to catch.
 *
 * No colour on either. This text is quoted verbatim into a JSON payload and
 * read by a model; see src/colour.ts for why that rules escape codes out.
 */
function briefHookPayload(text: string): string {
  return JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  })
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

  // Housekeeping, not reporting: it must never stop a report being
  // produced, so a failure here (a permissions error, a symlink where a
  // directory should be, anything) is swallowed rather than surfaced.
  try {
    prune(kanonHome(), Date.now())
  } catch {
    // See above.
  }

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
    // Two renderings of one report, and the plain one is the record. Colour
    // is a property of the terminal it is being printed to, never of the
    // report itself, so the file on disk -- read back later, by anything --
    // gets the same bytes whether or not this run had a terminal.
    const text = render(report)
    console.log(colourEnabled() ? render(report, COLOUR) : text)
    try {
      const dir = join(kanonHome(), 'reports')
      mkdirSync(dir, { recursive: true })
      writeAtomic(join(dir, `${session}.txt`), `${text}\n`)
    } catch {
      // A report that cannot be persisted was still printed. SessionEnd's
      // own budget, not a write failure here, is what the spec asks us to
      // survive without corrupting the file that's already there.
    }
    // Only SessionEnd commits. /kanon runs this same command mid-session,
    // and a commit there would erase the baseline this very report is
    // describing, making every subsequent run say "nothing changed".
    if (flag('commit-state')) {
      try {
        const stamp = new Date().toISOString()
        writeSnapshot(kanonHome(), {
          v: SNAPSHOT_VERSION,
          root: report.root,
          ruleset: report.ruleset,
          session,
          t: stamp,
          // Union with the previous snapshot arrives in the next task; this
          // commit still records only what this session observed.
          files: digest(report.loaded).map((d) => ({ ...d, lastSeen: stamp, present: true })),
        })
      } catch {
        // Housekeeping, like prune: a snapshot that cannot be written must
        // never stop a report that has already been printed.
      }
    }
    return
  }

  if (command === 'brief') {
    // Unlike `alarm`, this always speaks: a session where Claude is told
    // nothing about what governs it is the failure this command exists to
    // prevent, so an unrecorded session falls back to prediction rather
    // than to silence.
    const text = brief(briefInput(session, cwd), firstDirective)
    console.log(flag('hook') ? briefHookPayload(text) : text)
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

  if (command === 'notice') {
    // Nothing recorded means nothing to say, exactly as with `alarm`.
    if (!session || !existsSync(sessionFile(session))) return
    // Every recorded line ends in its own newline, so a plain split leaves a
    // trailing empty string that is not a line at all. Counting it would
    // make the watermark overshoot by one and, on a file with a single
    // trailing newline and nothing else, advance past a line that was never
    // examined -- filter it out so the watermark counts real lines only.
    //
    // This filtered count equals a plain `wc -l` only because the recorder
    // always ends the file on a trailing newline. A line truncated
    // mid-write (the recorder killed between the bytes and the newline) has
    // content, so `.trim().length > 0` does NOT drop it -- it is counted
    // here same as any complete line, and normalise() below turns its
    // broken JSON into an `unparsed` event that this loop's `e.ev !==
    // 'loaded'` check simply skips, so it never fires a notice (correctly:
    // there is nothing readable to report). What actually differs from a
    // complete line is that it has no trailing newline yet, so turn.sh's
    // `wc -l` does not count it until a later append completes it, and the
    // watermark this command writes below runs one ahead of what turn.sh
    // is comparing against. The two stay mismatched until that later
    // append lands, and that is the safe direction: the guard keeps
    // invoking Bun every turn in the meantime rather than ever settling on
    // a watermark that silently skipped past a line that could have
    // carried an alarm.
    const lines = readFileSync(sessionFile(session), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
    const seen = readWatermark(kanonHome(), session)
    const home = claudeHome()
    const root = sessionRoot(cwd)

    const fresh: Classified[] = []
    for (const e of normalise(lines.slice(seen))) {
      if (e.ev !== 'loaded') continue
      if (BRIEFED_REASONS.has(e.reason)) continue
      // Matches report.ts's discipline: realpath before both classifying and
      // storing. classify() realpaths its own argument internally, so the
      // FOREIGN verdict would be unaffected either way, but the unresolved
      // path is what gets stored into Classified.path and handed to
      // short(), which does a string-only path.relative() with no
      // filesystem resolution. Against a symlinked dependency path (pnpm's
      // node_modules layout, or /tmp and /var on macOS) that would print the
      // full path instead of the short one.
      const path = realPath(resolve(root, e.path))
      if (classify(path, root, home) !== 'foreign') continue
      if (fresh.some((f) => f.path === path)) continue
      fresh.push({ path, origin: 'foreign', reason: e.reason, viaImport: null, gitIgnored: null, gitTracked: null })
    }

    const text = notice({ root, files: fresh }, firstDirective)
    // Printed BEFORE the watermark advances. A crash between the two repeats
    // an alarm on the next turn; the reverse order would lose one, and for
    // an alarm a duplicate is the safe failure and silence is not.
    if (text.length > 0) {
      console.log(
        flag('hook')
          ? JSON.stringify({
              systemMessage: text,
              hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
            })
          : text,
      )
    }
    // Advanced whether or not there was anything to say, so a turn that
    // merely reloaded a known file does not make the guard spawn Bun again.
    try {
      writeWatermark(kanonHome(), session, lines.length)
    } catch {
      // A watermark that cannot be written costs a repeated notice, never a
      // lost one. Never worth failing the command over.
    }
    return
  }

  console.log('usage: kanon [report|brief|alarm|notice] [--session <id>] [--cwd <path>] [--hook] [--commit-state]')
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
