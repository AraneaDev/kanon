/**
 * The session's life as the mod follows it: registering `/kanon`, the
 * command toggling the pane, what a press does, and the end of a turn.
 * register.tsx wires each event to one of these and does nothing else.
 */
import type { Action } from '../lib/types'
import { acknowledge, refresh } from './cli'
import type { Port } from './port'
import { mod, PANE, paneClosed, paneOpened, setStatus, setView } from './state'

/** How long to wait before each retry of a refused registration; after the last, turn ends retry. */
const REGISTER_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

/**
 * Registers `/kanon`; false when the engine refuses, as it does when no
 * session is bound in the process yet (the moment after a hot reload). The
 * first refusal leaves one debug line.
 */
export async function registerCommand(io: Port): Promise<boolean> {
  if (mod.registration.registered) return true
  try {
    await io.command.register({ name: 'kanon', description: 'Open or close the Kanon pane' })
    mod.registration.registered = true
    return true
  } catch (err) {
    if (!mod.registration.failureLogged) {
      mod.registration.failureLogged = true
      try {
        io.ui.log(`kanon: could not register /kanon yet, retrying (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
      } catch {
        // A log line is never worth failing the hook for.
      }
    }
    return false
  }
}

/**
 * Registration at session start: a fresh generation, so a retry timer left
 * by an earlier start does nothing, and on a refusal the timed retries.
 */
export async function startRegistration(io: Port): Promise<void> {
  const generation = ++mod.registration.generation
  mod.registration.timer?.cancel()
  mod.registration.timer = null
  if (!(await registerCommand(io))) retryRegister(io, 0, generation)
}

/** Retries a refused registration after the `attempt`-th delay, then the next; past the last, the end of a turn tries again. */
function retryRegister(io: Port, attempt: number, generation: number): void {
  const delay = REGISTER_RETRY_MS[attempt]
  if (delay === undefined || mod.registration.registered || generation !== mod.registration.generation) return
  try {
    mod.registration.timer = io.clock.after(delay, () => {
      mod.registration.timer = null
      if (generation !== mod.registration.generation) return
      void registerCommand(io)
        .then(done => (done ? undefined : retryRegister(io, attempt + 1, generation)))
        .catch(() => undefined)
    })
  } catch {
    mod.registration.timer = null
  }
}

const isOpen = async (io: Port): Promise<boolean> => (await io.ui.panes()).some(p => p.id === PANE)

/** Reads the model off the hook, on the clock: a read takes up to 10 s, a hook's whole budget. */
function refreshSoon(io: Port): void {
  io.clock.after(0, () => void refresh(io).catch(() => undefined))
}

/** `/kanon` where a pane can draw: closes the pane when it is open, else opens it, focused, and reads the model. */
export async function toggle(io: Port): Promise<void> {
  if (await isOpen(io)) {
    paneClosed()
    await io.ui.close({ id: PANE }).catch(() => undefined)
    return
  }
  paneOpened(io)
  await io.ui.open({ id: PANE, title: 'Kanon', focus: true }).catch(() => undefined)
  refreshSoon(io)
}

/**
 * The end of a main-loop turn: a registration still refused after the timed
 * retries is asked for again, and an open pane reads the model again. A
 * subagent's turn, or an aborted one, changes nothing the pane shows.
 */
export async function endTurn(io: Port, agentId: string | undefined, isAborted: boolean): Promise<void> {
  if (agentId !== undefined) return
  if (!mod.registration.registered && mod.registration.timer === null) await registerCommand(io)
  if (isAborted || !(await isOpen(io))) return
  // A pane the engine still holds after a hot reload, which reset this module to "closed": adopted, so its read is shown.
  if (!mod.open) paneOpened(io)
  refreshSoon(io)
}

/** What pressing a Button (or its hotkey) does. */
export async function act(io: Port, action: Action): Promise<void> {
  if (action.kind === 'open') return setView(io, { kind: 'detail', real: action.real })
  if (action.kind === 'back') return setView(io, { kind: 'list' })
  if (action.kind === 'ack') return acknowledge(io, action.real)
  setStatus(io, { kind: 'loading' })
  await refresh(io)
}
