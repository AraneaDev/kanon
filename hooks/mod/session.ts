/**
 * The session's life as the mod follows it: registering `/kanon`, the
 * command toggling the pane, what a press does, and the end of a turn.
 * register.tsx wires each event to one of these and does nothing else.
 */
import { contentPage, contentScroll, type Target } from '../lib/layout'
import type { Action } from '../lib/types'
import { acknowledge, readContent, refresh } from './cli'
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
        // Landed at last: the session is bound now, so a pane held across the reload can be listed and adopted.
        .then(done => (done ? adoptOpenPane(io) : retryRegister(io, attempt + 1, generation)))
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

/**
 * `/kanon` where a pane can draw: closes the pane when it is open, else opens
 * it, focused, and reads the model. The close is left to the `ui.close` hook
 * (register.tsx), the one place every close lands, the person's included. An
 * open the engine failed or did not place is no open pane.
 */
export async function toggle(io: Port): Promise<void> {
  if (await isOpen(io)) {
    await io.ui.close({ id: PANE }).catch(() => undefined)
    return
  }
  paneOpened(io)
  const placed = await io.ui.open({ id: PANE, title: 'Kanon', focus: true }).then(
    r => (r as { isPlaced?: unknown } | undefined)?.isPlaced !== false,
    () => false,
  )
  if (!placed) return paneClosed()
  refreshSoon(io)
}

/**
 * A pane the engine holds while this module thinks it closed: after a hot
 * reload, which resets the module but may leave the pane on screen. Adopted,
 * so it reads the model at once instead of turning a stalled spinner until
 * the next turn ends. It never opens a pane: it only takes one that is there.
 */
export async function adoptOpenPane(io: Port): Promise<void> {
  if (mod.open || !(await isOpen(io))) return
  paneOpened(io)
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
  if (!mod.open) return adoptOpenPane(io)
  refreshSoon(io)
}

/** What pressing a Button (or its hotkey) does. */
export async function act(io: Port, action: Action): Promise<void> {
  if (action.kind === 'open') return setView(io, 'real' in action ? { kind: 'detail', real: action.real } : { kind: 'detail', injection: action.injection })
  if (action.kind === 'back') return back(io)
  if (action.kind === 'ack') return acknowledge(io, action.real)
  if (action.kind === 'view') return view(io)
  if (action.kind === 'next' || action.kind === 'previous') return page(io, action.kind === 'next' ? 1 : -1)
  setStatus(io, { kind: 'loading' })
  await refresh(io)
}

const targetOf = (v: Target): Target => ('real' in v ? { real: v.real } : { injection: v.injection })

/** `b`: one level back. The text goes back to the detail it was opened from, the detail to the list. */
function back(io: Port): void {
  const v = mod.view
  if (v.kind === 'content') {
    mod.content = null
    mod.reading += 1
    return setView(io, { kind: 'detail', ...targetOf(v) })
  }
  setView(io, { kind: 'list' })
}

/**
 * `v`: the text of what the detail shows. The content view opens at once,
 * reading, and the text replaces that when `kanon show` answers, unless the
 * person has gone back or closed the pane meanwhile.
 */
async function view(io: Port): Promise<void> {
  const v = mod.view
  if (v.kind !== 'detail') return
  const target = targetOf(v)
  const reading = ++mod.reading
  mod.content = { loading: true }
  setView(io, { kind: 'content', ...target, scroll: 0 })
  const content = await readContent(io, target)
  if (reading !== mod.reading || !mod.open) return
  mod.content = content
  io.ui.invalidate('ui.render')
}

/** `n` and `p`: a page of the text forward or back, a page being the rows the pane showed at its last render. */
function page(io: Port, dir: 1 | -1): void {
  if (mod.view.kind !== 'content') return
  scrollContent(io, mod.view.scroll + dir * contentPage(mod.drawn.columns, mod.drawn.rows))
}

/**
 * Moves the text to `to`, held inside it; false outside the content view.
 * The wheel and the page keys both land here, so they clamp alike.
 */
export function scrollContent(io: Port, to: number): boolean {
  const v = mod.view
  if (v.kind !== 'content') return false
  const scroll = contentScroll({ content: mod.content, ...mod.drawn }, to)
  if (scroll !== v.scroll) setView(io, { ...v, scroll })
  return true
}
