#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { writeAtomic } from './atomic'
import { ownerOf, pluginIndex } from './attribution'
import { brief, type BriefInput } from './brief'
import { COLOUR, colourEnabled, paintFor, stripControl } from './colour'
import { discover, subdirCandidates } from './discover'
import { digest, merge, SNAPSHOT_VERSION } from './drift'
import { prune, readStart, readTail } from './limits'
import { cleanLine, compactions, currentRun, normalise, transcriptOf } from './normalise'
import { BRIEFED_REASONS, notice } from './notice'
import { classify, sessionRoot } from './origin'
import { realPath, short } from './paths'
import { gitProbe, lastCommit } from './probe'
import { render } from './render'
import { renderAudit, type AuditEntry } from './audit'
import { matches, renderWhose } from './whose'
import { buildReport, driftable } from './report'
import { readAcks, readSnapshot, readSteering, readWarned, readWatermark, writeAcks, writeSnapshot, writeSteering, writeWarned, writeWatermark } from './state'
import { acknowledge, namedDigests, steer, type Steered } from './steering'
import { EMPTY_FACTS, readTranscript, type TranscriptFacts } from './transcript'
import type { Candidate, Classified, Event, Origin, Report } from './types'
import { warning } from './warning'

/** Absolute path to this file, so a command Kanon prints for Claude runs as printed. */
const CLI = join(import.meta.dir, 'cli.ts')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/**
 * The phrase `whose` searches for: the first argument after the command,
 * when it is not a flag. Taken positionally so a phrase can be typed as it
 * is remembered, rather than behind a flag name nobody would recall.
 */
function phraseArg(): string | undefined {
  const first = process.argv[3]
  return first !== undefined && !first.startsWith('--') ? first : undefined
}

/** Flags that take a value, so the value is never mistaken for a positional. */
const VALUED = new Set(['session', 'cwd', 'transcript', 'path'])

/**
 * The first argument after the command that is neither a flag nor a flag's
 * value. `ack` takes its item this way, after `--cwd`, exactly as the brief
 * prints the command.
 */
function positionalArg(): string | undefined {
  const argv = process.argv
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      if (VALUED.has(a.slice(2))) i++
      continue
    }
    return a
  }
  return undefined
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
    const trimmed = cleanLine(line)
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

/**
 * The report for one session. `withSteering` adds what else steered it --
 * stale flags, memories, hook injections, skills, compactions -- which only
 * `report` prints; `brief`, `whose` and `alarm` read loads alone and do not
 * pay for a plugin-cache walk or a staleness judgement they would discard.
 */
function collect(session: string, cwd: string, withSteering = false, mayJudge = true): Report {
  const file = sessionFile(session)
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  // Only this run's lines: a resumed session reuses its id, so the file can
  // also hold an earlier run's loads, recorded in another directory.
  const events = normalise(currentRun(lines))

  const home = claudeHome()
  const { root, candidates, skipped, importedBy } = discover(cwd, home)
  const previous = readSnapshot(kanonHome(), root)

  // One run-scoped read of the transcript serves every section built from it.
  const facts = transcriptFacts(events)
  const report = buildReport(events, candidates, root, home, importedBy, skipped, previous?.files ?? null, facts.instructions)
  return withSteering ? { ...report, ...steeredBy(report, events, facts, home, mayJudge) } : report
}

/**
 * What else steered the session, each part in its own guard: these are
 * courtesies, and none of them may stop the report the loads already make.
 *
 * Staleness comes from the cache the brief wrote at session start when there
 * is one, since that holds the user's acks as `kanon ack` last left them;
 * otherwise it is judged here exactly as the brief judges it, and not
 * cached, because writing the hot path's state is the brief's job.
 *
 * Except at SessionEnd (`mayJudge` false): its budget is shared with the
 * report write and the snapshot commit, and a judgement that overran it got
 * the hook killed before either was written. With no cache there, STALE is
 * left out rather than computed.
 */
function steeredBy(report: Report, events: Event[], facts: TranscriptFacts, home: string, mayJudge: boolean): Pick<Report, 'steered' | 'injections' | 'skills' | 'compactions'> {
  let steered: Steered[] = []
  try {
    steered = readSteering(kanonHome(), report.root) ?? (mayJudge ? judgeSteering(report.root, report.loaded, events, facts) : null) ?? []
  } catch {
    // No stale flags is the honest answer to a failure to judge.
  }
  let injections: Report['injections'] = []
  try {
    const index = pluginIndex(join(home, 'plugins', 'cache'))
    injections = facts.injections.map((i) => ({ ...i, plugin: ownerOf(i.command, index) }))
  } catch {
    // Attribution is a courtesy; see attribution.ts.
  }
  // A skill is listed again each time the transcript restates what has been
  // invoked, so a name is shown once, where it was first seen.
  const names = new Set<string>()
  const skills = facts.skills.filter((s) => !names.has(s.name) && names.add(s.name))
  return { steered, injections, skills, compactions: facts.compactions }
}

/**
 * What the session transcript says about the current run, or nothing.
 *
 * One transcript spans every run of a session, possibly in several roots, so
 * it is read by its tail, where the current run is, and cut at the run's
 * start. `events` are already this run's only, so their last start event is
 * the boundary. Kanon's own `t` is truncated to the second, which puts it at
 * or before every transcript record of the same run, so no slack is needed.
 * No start event, or a missing or unreadable transcript, is no evidence about
 * this run and degrades to EMPTY_FACTS rather than costing the report.
 */
function transcriptFacts(events: Event[]): TranscriptFacts {
  const path = transcriptOf(events)
  let since: Date | null = null
  for (const e of events) if (e.ev === 'start') since = new Date(e.t)
  if (path === null || since === null || Number.isNaN(since.getTime())) return EMPTY_FACTS
  const buf = readTail(path)
  return buf === null ? EMPTY_FACTS : readTranscript(buf.toString('utf8'), since)
}

/**
 * A file's text up to the size ceiling, or null when it cannot be read. An
 * oversized file is read by its start, the part Claude Code loads, so it is
 * searched and quoted like any other. A multibyte character split at the cut
 * decodes as a replacement character, which is harmless in an excerpt.
 */
function readBounded(path: string): string | null {
  return readStart(path)?.toString('utf8') ?? null
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
  const text = readBounded(path)
  if (text === null) return null
  let inFrontMatter = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('---')) {
      inFrontMatter = !inFrontMatter
      continue
    }
    if (inFrontMatter || line.startsWith('#')) continue
    // Stripped here, where a file Kanon did not write is first read, so
    // every reader of this quote is covered rather than each render site.
    const clean = stripControl(line)
    return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean
  }
  return null
}

/**
 * A row for a file Kanon has not watched load, or watched through a path
 * that never goes through buildReport: no import edge and no git facts,
 * because nothing here looked them up.
 */
function unobserved(path: string, origin: Origin, reason: string): Classified {
  return { path, origin, reason, viaImport: null, gitIgnored: null, gitTracked: null }
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
  return launchFiles(discover(cwd, home).candidates, root, home)
}

function launchFiles(candidates: Candidate[], root: string, home: string): Classified[] {
  return candidates
    .filter((c) => c.label === 'launch')
    .map((c) => unobserved(c.path, classify(c.path, root, home), 'expected at launch'))
}

/**
 * Every candidate that can load in this session: at launch, on a path
 * match, or when Claude enters a subdirectory. A path-scoped rule or a
 * nested CLAUDE.md never loads at session start, so judging only the launch
 * set left the mid-session notice and the report's STALE with nothing to
 * say about them. An excluded file never loads, and an unreachable one
 * cannot, so neither is judged.
 */
const JUDGED_LABELS: ReadonlySet<Candidate['label']> = new Set(['launch', 'path-scoped', 'on-demand'])
function loadableFiles(candidates: Candidate[], root: string, home: string): Classified[] {
  return candidates
    .filter((c) => JUDGED_LABELS.has(c.label))
    .map((c) => unobserved(c.path, classify(c.path, root, home), c.label))
}

/**
 * The report for this session, or null when the session was not observed.
 * `brief` and `whose` both fall back to prediction on null; this is the one
 * place that decides which of the two they speak from.
 */
function observedReport(session: string | undefined, cwd: string): Report | null {
  if (session === undefined || !existsSync(sessionFile(session))) return null
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
    return null
  }
  // An existing but empty log is still an unobserved session: the file can
  // be created by a hook that recorded nothing usable. Reporting "no
  // instruction files govern you" there would be a confident lie, so it
  // falls back to prediction like any other unrecorded session.
  return report.loaded.length === 0 ? null : report
}

/**
 * This run's events for a session, or none when there is no readable log.
 * Unlike collect(), an unreadable log is not an error here: the brief only
 * wants the transcript path the SessionStart recorded, and must always speak.
 */
function runEvents(session: string | undefined): Event[] {
  if (session === undefined) return []
  try {
    return normalise(currentRun(readFileSync(sessionFile(session), 'utf8').split('\n')))
  } catch {
    return []
  }
}

/**
 * When an item was last written, which is what `may-be-stale` measures a
 * named file's commits against. An instruction file in the checkout is dated
 * by its last commit, because a fresh clone gives every file today's mtime;
 * anything else, and every memory, by its mtime. A file outside the root is
 * never in this repository's history, so it costs no git spawn. A stat that
 * fails throws, and steer() turns that into no verdict.
 */
function writtenAt(root: string, path: string, kind: Steered['kind'], deadline?: number): Date {
  const rel = relative(root, path)
  const inRoot = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  const commit = kind === 'instruction' && inRoot ? lastCommit(root, path, deadline) : null
  return commit ?? statSync(path).mtime
}

/**
 * Everything that steers this session, judged, and cached for the hot-path
 * hooks to read. `root` must be the resolved sessionRoot(): the cache and
 * the acks are keyed by that string, and a second spelling of the same
 * checkout would read and write a different file.
 *
 * The memory directory sits beside the transcript. The SessionStart hook
 * passes the transcript path; run by hand, the path the recorded
 * SessionStart named stands in.
 *
 * The brief must always speak, so any failure in judging falls back to the
 * instruction files alone with no verdicts, and that fallback is never
 * cached: a cache with no verdicts would tell the hot path nothing is stale,
 * when the truth is that nothing was checked. A cache that cannot be written
 * costs the hot path its notes, never this brief its verdicts.
 */
function steering(root: string, files: Classified[], events: Event[]): Steered[] {
  const steered = judgeSteering(root, files, events, transcriptFacts(events))
  if (steered === null) {
    return files.map((f) => ({ path: realPath(f.path), kind: 'instruction', origin: f.origin, digest: null, verdict: null, acknowledged: false }))
  }
  try {
    writeSteering(kanonHome(), root, steered)
  } catch {
    // Housekeeping for the hot path; see above.
  }
  return steered
}

/**
 * How long judging may run, from its start: about 3 s of SessionStart's 5,
 * leaving the rest for Bun's start, discovery and the cache write. Items not
 * reached by then are listed unjudged. KANON_JUDGE_BUDGET_MS overrides it so
 * a test can exhaust it; it is not a user setting.
 */
const JUDGE_BUDGET_MS = 3000
function judgeBudget(): number {
  const v = Number(process.env.KANON_JUDGE_BUDGET_MS)
  const set = process.env.KANON_JUDGE_BUDGET_MS !== undefined && process.env.KANON_JUDGE_BUDGET_MS !== ''
  return set && Number.isFinite(v) && v >= 0 ? v : JUDGE_BUDGET_MS
}

/**
 * The steering model for a root, judged now and not cached, or null when
 * judging failed. Shared by the brief and the report so the two judge with
 * the same probe, the same home and the same memory directory.
 */
function judgeSteering(root: string, files: Classified[], events: Event[], facts: TranscriptFacts): Steered[] | null {
  const transcript = arg('transcript') || transcriptOf(events)
  // One deadline bounds the judging and every git call inside it, so
  // discovery, judging and the cache write stay inside SessionStart's 5 s.
  const deadline = Date.now() + judgeBudget()
  try {
    return steer({
      root,
      // The user's home, not the Claude config dir: a note's `~/` means the
      // former, and resolving it against the latter would call real files gone.
      home: homedir(),
      instructions: files,
      memoryDir: transcript ? join(dirname(transcript), 'memory') : null,
      facts,
      probe: gitProbe(root, { deadline }),
      written: (path, kind) => writtenAt(root, path, kind, deadline),
      read: readBounded,
      acks: readAcks(kanonHome(), root),
      deadline,
    })
  } catch {
    return null
  }
}

function briefInput(session: string | undefined, cwd: string): BriefInput {
  const report = observedReport(session, cwd)
  const home = claudeHome()
  // Both come from sessionRoot(), so both are already realpathed.
  const root = report ? report.root : sessionRoot(cwd)
  const { candidates } = discover(cwd, home)
  const files = report ? report.loaded : launchFiles(candidates, root, home)
  // Everything that can load is judged into the cache, for the notice and
  // the report; the brief speaks only of what governs the session now --
  // the files above and the memories -- so its count and rows are those.
  // `files` go first, so an observed load keeps its own classification.
  const judged = steering(root, [...files, ...loadableFiles(candidates, root, home)], runEvents(session))
  const shown = new Set(files.map((f) => realPath(f.path)))
  // Drift is no longer the brief's to tell: the report carries it, and the
  // brief names only what is gone or foreign.
  return {
    root,
    basis: report ? 'observed' : 'predicted',
    files,
    missing: report ? report.missing : [],
    steered: judged.filter((s) => s.kind === 'memory' || shown.has(s.path)),
    cli: CLI,
  }
}

/**
 * The payload for a hook that speaks, addressed to both of its readers.
 *
 * `systemMessage` is shown in the transcript and, per Claude Code's hook
 * contract, is explicitly *not* added to Claude's context -- "Claude never
 * sees it". The brief exists to calibrate Claude's trust in instructions it
 * holds with no attribution, and it closes by asking Claude to raise anything
 * alarming with the user; on that channel alone, both were addressed to a
 * reader that never received them. `hookSpecificOutput.additionalContext` is
 * the channel that does reach the model, on SessionStart, UserPromptSubmit
 * and PreToolUse alike. Neither field is a decision: on PreToolUse in
 * particular, Kanon adds context to a Read and never allows, asks or denies.
 *
 * Both are emitted rather than one: the user keeps the visible line in the
 * transcript, and Claude gets the text that was written for it. The two carry
 * the same string on purpose -- a brief that said different things to the two
 * readers would be the one bug this tool exists to catch. Built here only, so
 * a hook that starts speaking later cannot get the envelope half right.
 *
 * No colour on either. This text is quoted verbatim into a JSON payload and
 * read by a model; see src/colour.ts for why that rules escape codes out.
 */
function hookPayload(event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse', text: string): string {
  return JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
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

/**
 * Only SessionEnd commits. /kanon runs this same command mid-session,
 * and a commit there would erase the baseline this very report is
 * describing, making every subsequent run say "nothing changed".
 * An unobserved session (nothing recorded, or a log that recorded
 * nothing usable) is not evidence about the repository. merge() unions
 * rather than replacing, so it never returns an empty list once a
 * baseline exists -- writeSnapshot's own empty-files guard, which used
 * to be what stopped an empty session from overwriting a real baseline,
 * is dead code against that union. Left in place anyway: it still
 * catches the first-ever session in a root, which has no baseline for
 * merge() to union against. Without the caller's guard, a `git checkout` or a
 * `bun install` racing SessionEnd would be read as this session's
 * filesystem truth and move files to absent-unreported and back for no
 * reason connected to anything Kanon actually watched load.
 */
function commitSnapshot(report: Report, session: string): void {
  try {
    const stamp = new Date().toISOString()
    // Read the previous snapshot again rather than threading it out of
    // collect(): it is a small JSON file, and the alternative is another
    // parameter on a function that already has enough.
    const previous = readSnapshot(kanonHome(), report.root)
    writeSnapshot(kanonHome(), {
      v: SNAPSHOT_VERSION,
      root: report.root,
      ruleset: report.ruleset,
      session,
      t: stamp,
      // The union is what makes this a record of the repository rather
      // than of this session. Without it the session that visited fewest
      // directories overwrites a richer snapshot, and the next session
      // announces long-standing files as new.
      files: merge(previous?.files ?? null, digest(driftable(report.loaded, report.autoMemory)), existsSync, new Date(stamp)),
    })
  } catch {
    // Housekeeping, like prune: a snapshot that cannot be written must
    // never stop a report that has already been printed.
  }
}

function runReport(session: string | undefined, cwd: string): void {
  if (!session) {
    // Never fall back to a session from a different repository: say
    // plainly that there's nothing recorded here rather than guess.
    console.log(`kanon: no recorded session found for ${cwd}`)
    return
  }
  // SessionEnd passes --commit-state, and SessionEnd never judges.
  const report = collect(session, cwd, true, !flag('commit-state'))
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
  if (flag('commit-state') && report.loaded.length > 0) commitSnapshot(report, session)
}

function runBrief(session: string | undefined, cwd: string): void {
  // Unlike `alarm`, this always speaks: a session where Claude is told
  // nothing about what governs it is the failure this command exists to
  // prevent, so an unrecorded session falls back to prediction rather
  // than to silence.
  const text = brief(briefInput(session, cwd), firstDirective)
  console.log(flag('hook') ? hookPayload('SessionStart', text) : text)
}

function runAudit(cwd: string): void {
  const home = claudeHome()
  const root = sessionRoot(cwd)
  // The predicted set, plus the directories discovery normally refuses to
  // enter. Both are needed: the first covers what launches and what the
  // rules directories hold, the second is the dependency tree, which is
  // where the file nobody chose to install usually sits.
  const { candidates } = discover(cwd, home)
  const seen = new Set(candidates.map((c) => c.path))
  const swept = subdirCandidates(root, true).filter((c) => !seen.has(c.path))

  const entries: AuditEntry[] = [...candidates, ...swept].map((c) => ({
    path: c.path,
    origin: classify(c.path, root, home),
    label: c.label,
  }))

  // Colour only for a person looking at a terminal, exactly as `report`
  // does. A piped or captured audit stays plain.
  console.log(renderAudit(root, entries, firstDirective, paintFor()))
}

function runWhose(phrase: string, session: string | undefined, cwd: string): void {
  const report = observedReport(session, cwd)
  const root = report ? report.root : sessionRoot(cwd)
  const files = report ? report.loaded : predictedFiles(cwd, claudeHome(), root)
  const basis = report ? 'observed' : 'predicted'
  console.log(renderWhose(phrase, matches(files, phrase, readBounded), basis, root, files.length, paintFor()))
}

function runAlarm(session: string | undefined, cwd: string): void {
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
}

/** The foreign files among `lines` that loaded for a reason the brief did not already name. */
function freshForeign(lines: string[], root: string, home: string): Classified[] {
  const fresh: Classified[] = []
  for (const e of normalise(lines)) {
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
    fresh.push(unobserved(path, 'foreign', e.reason))
  }
  return fresh
}

/**
 * The flagged items among `lines` that loaded for a reason the brief did not
 * already name, in the steering cache with a verdict, not acknowledged, and
 * not in `warned`. Loaded paths are realpathed to meet the cache's keys.
 */
function freshFlagged(lines: string[], root: string, warned: string[]): Steered[] {
  const cache = readSteering(kanonHome(), root) ?? []
  const flagged: Steered[] = []
  for (const e of normalise(lines)) {
    if (e.ev !== 'loaded' || BRIEFED_REASONS.has(e.reason)) continue
    const path = realPath(resolve(root, e.path))
    const item = cache.find((s) => s.path === path)
    if (!item || item.verdict === null || item.acknowledged) continue
    if (warned.includes(path) || flagged.some((f) => f.path === path)) continue
    flagged.push(item)
  }
  return flagged
}

function runNotice(session: string | undefined, cwd: string): void {
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
  // here same as any complete line, and normalise() inside freshForeign()
  // turns its broken JSON into an `unparsed` event that the loop's `e.ev !==
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
  const root = sessionRoot(cwd)
  const fresh = freshForeign(lines.slice(seen), root, claudeHome())

  const slice = lines.slice(seen)
  const now = epoch(session)
  const warned = readWarned(kanonHome(), session)
  const warnedPaths = warned.epoch === now ? warned.paths : []
  const flagged = freshFlagged(slice, root, warnedPaths)

  const text = notice({ root, files: fresh, flagged, cli: CLI }, firstDirective)
  // Printed BEFORE the watermark advances. A crash between the two repeats
  // an alarm on the next turn; the reverse order would lose one, and for
  // an alarm a duplicate is the safe failure and silence is not.
  if (text.length > 0) console.log(flag('hook') ? hookPayload('UserPromptSubmit', text) : text)
  // Advanced whether or not there was anything to say, so a turn that
  // merely reloaded a known file does not make the guard spawn Bun again.
  try {
    writeWatermark(kanonHome(), session, lines.length)
  } catch {
    // A watermark that cannot be written costs a repeated notice, never a
    // lost one. Never worth failing the command over.
  }
  if (flagged.length > 0) {
    try {
      writeWarned(kanonHome(), session, { epoch: now, paths: [...warnedPaths, ...flagged.map((f) => f.path)] })
    } catch {
      // A record that cannot be written costs a repeated warning, never a lost one.
    }
  }
}

/**
 * The item `ack` names, spelled as the brief and the Read warning print it:
 * `~/...` for a file under the user's home, root-relative for a project
 * file, or absolute. `~` is the user's home, never the Claude config dir,
 * because that is what short() abbreviated. The result is realpathed, like
 * every path in the steering cache it is looked up in.
 */
function itemPath(spelled: string, root: string): string {
  const expanded = spelled === '~' || spelled.startsWith('~/') ? join(homedir(), spelled.slice(1)) : resolve(root, spelled)
  return realPath(expanded)
}

/**
 * `kanon ack`: the user saying a flagged item still holds. It records the
 * item's digest as the session start judged it, and the digest of every
 * file it names now, so a later change to either makes the flag speak again.
 * The cached digest rather than a fresh one: an item edited since the brief
 * is no longer the claim the user was shown, and acknowledging it under the
 * new digest would silence something nobody looked at.
 *
 * The cache row is marked acknowledged too, because `warn` reads only the
 * cache. Without it an ack would not quiet the Read warning until the next
 * session start recomputed the row.
 *
 * An item that is not flagged is said plainly, with exit 0: a stale command
 * pasted from an old brief is not an error worth a stack trace.
 */
function runAck(spelled: string | undefined, cwd: string): void {
  if (spelled === undefined) {
    console.log('usage: kanon ack --cwd <path> <item-path>')
    return
  }
  const root = sessionRoot(cwd)
  const path = itemPath(spelled, root)
  const items = readSteering(kanonHome(), root) ?? []
  const item = items.find((s) => s.path === path && s.verdict !== null)
  if (!item) {
    console.log(`kanon: ${spelled} is not flagged`)
    return
  }
  // Same `home` the brief judged with, so the recorded names match the ones
  // isAcknowledged() computes at the next session start.
  const named = namedDigests(readBounded(path) ?? '', path, root, homedir())
  const acks = readAcks(kanonHome(), root).filter((a) => a.path !== path)
  writeAcks(kanonHome(), root, [...acks, acknowledge(item, named, new Date())])
  writeSteering(kanonHome(), root, items.map((s) => (s.path === path ? { ...s, acknowledged: true } : s)))
  // Printed after both writes: a confirmation of something that did not
  // happen would be worse than the error main() reports instead.
  console.log(`kanon: acknowledged ${short(path, root)}`)
}

/**
 * The compaction epoch: compact starts across the whole log, not the current
 * run. currentRun() starts at the last SessionStart of any source, compact
 * included, so within it the count is never more than one, and a second
 * compact would read as the same epoch as the first and lose its warning.
 * Counted over every run the count only ever grows within a session, which
 * is all the warned record needs. An unreadable log is epoch 0.
 */
function epoch(session: string): number {
  try {
    return compactions(normalise(readFileSync(sessionFile(session), 'utf8').split('\n')))
  } catch {
    return 0
  }
}

/**
 * `kanon warn`, behind the PreToolUse Read hook. It reads the steering cache
 * and nothing else Kanon would have to compute: read.sh has already bailed
 * for anything that is not a memory, and this runs before every such Read.
 *
 * Once per item per compaction epoch: a compact drops the earlier warning
 * from Claude's context, so the next Read of the item warns again. Printed
 * BEFORE the warned record is written, as `notice` prints before its
 * watermark: a crash between the two repeats a warning, the reverse order
 * would lose one.
 */
function runWarn(session: string | undefined, cwd: string): void {
  const file = arg('path')
  if (!session || !file) return
  // The id names a file under state/, and read.sh's guard is not the only
  // way to reach this command.
  if (session.includes('/') || session.startsWith('.')) return
  const root = sessionRoot(cwd)
  const path = realPath(resolve(cwd, file))
  const item = readSteering(kanonHome(), root)?.find((s) => s.path === path)
  if (!item || item.verdict === null || item.acknowledged) return

  const now = epoch(session)
  const warned = readWarned(kanonHome(), session)
  const paths = warned.epoch === now ? warned.paths : []
  if (paths.includes(path)) return

  const text = warning(item, root, CLI)
  console.log(flag('hook') ? hookPayload('PreToolUse', text) : text)
  try {
    writeWarned(kanonHome(), session, { epoch: now, paths: [...paths, path] })
  } catch {
    // A record that cannot be written costs a repeated warning, never a lost one.
  }
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

  if (command === 'report') return runReport(session, cwd)
  if (command === 'brief') return runBrief(session, cwd)
  if (command === 'audit') return runAudit(cwd)
  if (command === 'alarm') return runAlarm(session, cwd)
  if (command === 'notice') return runNotice(session, cwd)
  if (command === 'ack') return runAck(positionalArg(), cwd)
  if (command === 'warn') return runWarn(sessionArg, cwd)
  if (command === 'whose') {
    const phrase = phraseArg()
    // No phrase falls through to the usage line rather than searching for
    // the empty string, which would otherwise match every file at offset 0.
    if (phrase !== undefined) return runWhose(phrase, session, cwd)
  }

  console.log('usage: kanon [report|brief|alarm|notice|whose <phrase>|audit|ack <item-path>|warn] [--session <id>] [--cwd <path>] [--path <file>] [--transcript <path>] [--hook] [--commit-state]')
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
