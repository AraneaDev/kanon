/**
 * The Kanon CLI, run through the port: the argv for each command, the
 * runtime it runs under, and what the pane makes of its answers. The pure
 * parts (`cliArgv`, `parseModel`, `fenced`) are tested by bun in
 * test/pane-cli.test.ts; the rest under `claude plugin test`.
 *
 * Every argument is its own argv element and nothing goes through a shell,
 * so a path holding a space, a quote or `$(x)` reaches the CLI as one
 * string, exactly as it is.
 */
import type { PaneModel } from '../../src/model'
import { stripControl } from '../lib/control'
import type { Status } from '../lib/layout'
import type { Port, RunResult } from './port'
import { mod, say, setStatus } from './state'

/** The model version the pane draws (src/model.ts MODEL_VERSION; not imported, the mod loads no file outside hooks/). */
const MODEL_VERSION = 1
/** A read of the model. Run off the hook (on the clock), so it does not count against a hook's 10 s. */
const MODEL_TIMEOUT_MS = 10_000
/** The report and an acknowledge. The report runs inside the command hook, so it stays under the hook's 10 s. */
const REPORT_TIMEOUT_MS = 8_000
const ACK_TIMEOUT_MS = 8_000
/** The most of a reason the pane quotes from output it could not read. */
const QUOTE_MAX = 200

/** `bun <plugin root>/src/cli.ts <args...>`, each argument its own element. */
export function cliArgv(bun: string, root: string, args: readonly string[]): string[] {
  return [bun, `${root.replace(/\/+$/, '')}/src/cli.ts`, ...args]
}

/** The first line of output Kanon did not shape, stripped of control characters (see `control.ts`) and cut. */
const firstLine = (text: string): string => stripControl(text.trim().split('\n')[0] ?? '').slice(0, QUOTE_MAX)

/**
 * What the pane makes of `kanon model --json`'s stdout: the model, or why
 * not. The CLI answers every failure with one `{ error }` object, so its
 * reason is shown as it is; anything else that is not a model (nothing, a
 * crash's text, JSON of another shape) is an error too, never a half-drawn
 * pane.
 */
export function parseModel(stdout: string): Status {
  const text = stdout.trim()
  if (text === '') return { kind: 'error', reason: 'kanon printed nothing.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'error', reason: `kanon printed something that is not JSON: ${firstLine(text)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'error', reason: 'kanon printed JSON that is not a pane model.' }
  const o = parsed as Record<string, unknown>
  if (typeof o.error === 'string') return { kind: 'error', reason: stripControl(o.error) }
  if (o.v !== MODEL_VERSION) return { kind: 'error', reason: `kanon printed model version ${String(o.v)}; this pane reads version ${MODEL_VERSION}.` }
  const lists = ['instructions', 'memory', 'injected', 'skills', 'compactions'] as const
  if (typeof o.root !== 'string' || typeof o.basis !== 'string' || !lists.every(k => Array.isArray(o[k]))) {
    return { kind: 'error', reason: 'kanon printed JSON that is not a pane model.' }
  }
  return { kind: 'ready', model: parsed as PaneModel }
}

/** `text` in a code fence longer than any run of backticks inside it, so the report cannot close it early. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text.replace(/\n+$/, '')}\n${fence}`
}

const message = (err: unknown): string => stripControl(err instanceof Error ? err.message : String(err))

/**
 * Whether a run failed by running out of time. `$.process.run` rejects for
 * two reasons only, the runtime could not start or it timed out, and the
 * wording of the first is not a contract, so every rejection but a timeout
 * is taken for a runtime that did not start, the one failure the fallback
 * runtime can mend. A timeout never is: the runtime started, and a second
 * try would spend another timeout, past the command hook's 10 s.
 */
function timedOut(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'ETIMEDOUT') return true
  const text = err instanceof Error ? err.message : String(err)
  return /timed?\s*out|timeout/i.test(text)
}

/**
 * Runs the CLI: under `bun` first, then `~/.bun/bin/bun` when a bare `bun`
 * was rejected for anything but a timeout (a PATH without it, as a
 * GUI-launched Claude Code often has). A timeout is the answer: it is not
 * tried again. The runtime that started is kept, so later runs go straight to it.
 */
export async function runCli(io: Port, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  const candidates = mod.bun !== null ? [mod.bun] : await runtimes(io)
  const errors: string[] = []
  for (const bun of candidates) {
    try {
      const result = await io.process.run(cliArgv(bun, io.plugin.root, args), { timeoutMs })
      mod.bun = bun
      return result
    } catch (err) {
      errors.push(message(err))
      if (timedOut(err)) break
    }
  }
  throw new Error(errors.join('; '))
}

async function runtimes(io: Port): Promise<string[]> {
  const home = await io.env.home().catch(() => undefined)
  return home === undefined || home === '' ? ['bun'] : ['bun', `${home.replace(/\/+$/, '')}/.bun/bin/bun`]
}

/** One read of the model: the status the pane shows for it. */
async function readModel(io: Port): Promise<Status> {
  try {
    const [id, cwd] = await Promise.all([io.session.id(), io.session.cwd()])
    const result = await runCli(io, ['model', '--json', '--session', id, '--cwd', cwd], MODEL_TIMEOUT_MS)
    const status = parseModel(result.stdout)
    // The CLI exits 0 on every failure it knows of; anything else crashed it, and its stderr says more than stdout.
    if (status.kind === 'error' && result.exitCode !== 0 && result.stderr.trim() !== '') return { kind: 'error', reason: `kanon exited ${result.exitCode}: ${firstLine(result.stderr)}` }
    return status
  } catch (err) {
    return { kind: 'error', reason: `kanon could not run: ${message(err)}` }
  }
}

/**
 * Reads the model and shows it, one read at a time. A request while a read
 * runs is not a second read beside it: it asks for one more after it, so a
 * turn or an acknowledge that ended mid-read is still seen. A read that
 * lands after the pane closed is dropped; one that lands after it closed and
 * opened again is followed by a read for the new pane.
 */
export async function refresh(io: Port): Promise<void> {
  // A closed pane reads nothing: what it would show is gone with it.
  if (!mod.open) return
  if (mod.refresh.running) {
    mod.refresh.again = true
    return
  }
  mod.refresh.running = true
  try {
    do {
      mod.refresh.again = false
      const generation = mod.generation
      const status = await readModel(io)
      if (generation !== mod.generation) {
        mod.refresh.again = mod.open
        continue
      }
      if (mod.open) setStatus(io, status)
    } while (mod.refresh.again && mod.open)
  } finally {
    mod.refresh.running = false
  }
}

/**
 * `kanon ack --cwd <cwd> <real>`: the person saying a flagged item still
 * holds, the same record the CLI writes when typed. The footer says how it
 * went for two seconds, and the model is read again so the flag clears.
 */
export async function acknowledge(io: Port, real: string): Promise<void> {
  try {
    const cwd = await io.session.cwd()
    const { stdout } = await runCli(io, ['ack', '--cwd', cwd, real], ACK_TIMEOUT_MS)
    say(io, stdout.startsWith('kanon: acknowledged') ? '✓ acknowledged' : 'not acknowledged')
  } catch {
    say(io, 'not acknowledged')
  }
  await refresh(io)
}

/** The report, fenced, for a session with nothing to draw a pane on; or one line saying why there is none. */
export async function reportText(io: Port): Promise<string> {
  try {
    const [id, cwd] = await Promise.all([io.session.id(), io.session.cwd()])
    const { exitCode, stdout, stderr } = await runCli(io, ['report', '--session', id, '--cwd', cwd], REPORT_TIMEOUT_MS)
    // The CLI exits 0 with a report; anything else crashed it, and an empty fence would hide why.
    if (exitCode !== 0 || stdout.trim() === '') {
      const why = firstLine(stderr) || firstLine(stdout) || 'it printed nothing'
      return `kanon: could not run the report (exit ${exitCode}: ${why})`
    }
    return fenced(stdout)
  } catch (err) {
    return `kanon: could not run the report (${message(err)})`
  }
}
