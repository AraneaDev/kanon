/**
 * The session's life as the mod follows it: registering `/kanon`, the
 * command toggling the pane, what a press does, and the end of a turn.
 * register.tsx wires each event to one of these and does nothing else.
 */
import { contentPage, contentScroll, targetKey, textTarget, type Content, type LayoutInput, type Target } from '../lib/layout'
import type { Action } from '../lib/types'
import { acknowledge, readContent, refresh } from './cli'
import type { Port } from './port'
import { forgetText, mod, PANE, paneClosed, paneOpened, setStatus, setView } from './state'

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
  // Transparent: the pane lies on the terminal's own background, as the chat beside it does.
  // A Claude Code from before `backgroundColor` refuses it, and gets the pane on its own fill.
  const placed = await io.ui
    .open({ id: PANE, title: 'Kanon', focus: true, backgroundColor: 'transparent' })
    .catch(() => io.ui.open({ id: PANE, title: 'Kanon', focus: true }))
    .then(
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
  if (action.kind === 'open') return open(io, 'real' in action ? { real: action.real } : { hook: action.hook })
  if (action.kind === 'back') return back(io)
  if (action.kind === 'card') return setView(io, { kind: 'card', group: action.group, scroll: 0 })
  if (action.kind === 'ack') return acknowledge(io, action.real)
  if (action.kind === 'next' || action.kind === 'previous') return page(io, action.kind === 'next' ? 1 : -1)
  setStatus(io, { kind: 'loading' })
  await refresh(io)
}

/**
 * Opening a file or a hook: its details at once, from the top of its
 * text, and the text read now, afresh even when a preview already holds it,
 * so what the person opens is what the file says now.
 */
function open(io: Port, target: Target): void {
  // Opened from a card on its own, `b` comes back to that card where it was.
  const from = mod.view.kind === 'card' ? { from: mod.view } : {}
  setView(io, { kind: 'detail', ...target, scroll: 0, ...from })
  wantText(io, target, true)
}

/** `b`: back in one step, to the card a file was opened from, else to the list. The text goes with the detail; a wide pane's render asks for its preview's. */
function back(io: Port): void {
  wantText(io, null)
  const v = mod.view
  setView(io, v.kind === 'detail' && v.from !== undefined ? v.from : { kind: 'list' })
}

/**
 * Asks for the text of `target` (none for null). Nothing happens when it is
 * already the text held or being read, unless `fresh`. Otherwise what is held
 * goes, the pane says it is reading, and one `show` runs for it: after the
 * one in flight, if there is one, whose answer is then dropped.
 */
export function wantText(io: Port, target: Target | null, fresh = false): void {
  const key = target === null ? null : targetKey(target)
  if (!fresh && key === mod.text.key) return
  forgetText()
  if (target === null) return
  mod.text.key = key
  mod.text.target = target
  mod.text.content = { loading: true }
  io.ui.invalidate('ui.render')
  void readText(io).catch(() => undefined)
}

/**
 * Reads what is wanted, one `show` at a time, until what is wanted is read.
 * An answer that lands under another ticket (the person went back, opened
 * something else, or the preview moved on) or for a pane that has closed
 * since is dropped, and whatever is wanted now is read next.
 */
async function readText(io: Port): Promise<void> {
  if (mod.text.running) return
  mod.text.running = true
  try {
    while (mod.open && mod.text.target !== null && mod.text.content !== null && 'loading' in mod.text.content) {
      const { ticket, target } = mod.text
      const generation = mod.generation
      const content = await readContent(io, target)
      if (ticket !== mod.text.ticket || generation !== mod.generation || !mod.open) continue
      mod.text.content = content
      io.ui.invalidate('ui.render')
    }
  } finally {
    mod.text.running = false
  }
}

/**
 * At a render: the text the frame about to be drawn shows, and a read asked
 * for when that is not the text held. The wide tier's preview follows the
 * list (its first flagged item changes as the model does), and only a render
 * knows the width, so the render is where a preview's read is asked for. It
 * is asked for on the clock, off the render, which must stay pure drawing.
 */
export function textFor(io: Port, input: Pick<LayoutInput, 'status' | 'view' | 'columns'>): Content | null {
  let target: Target | null
  try {
    target = textTarget(input)
  } catch {
    // A model the layout cannot draw: the render's error view shows instead, and it has no text.
    return null
  }
  if (target === null) return null
  const key = targetKey(target)
  if (key === mod.text.key) return mod.text.content
  try {
    // The pane may have moved on before the clock runs: what is asked for is what it shows then.
    io.clock.after(0, () => (mod.open ? wantText(io, textTarget({ status: mod.status, view: mod.view, columns: mod.drawn.columns })) : undefined))
  } catch {
    // No clock (the session torn down): the preview says it is reading, and nothing else is lost.
  }
  return { loading: true }
}

/** `n` and `p`: a page of the text, or of a card on its own, forward or back, a page being the rows the pane showed at its last render. */
function page(io: Port, dir: 1 | -1): void {
  const v = mod.view
  if (v.kind === 'list') return
  scrollContent(io, (v.scroll ?? 0) + dir * contentPage(pagingInput()))
}

/** What the paging depends on, as the mod holds it, at the size of the last render. */
const pagingInput = () => ({ status: mod.status, view: mod.view, content: mod.text.content, ...mod.drawn })

/**
 * Moves the text, or a card on its own, to `to`, held inside it; false on
 * the list. The wheel and the page keys both land here, so they clamp alike.
 */
export function scrollContent(io: Port, to: number): boolean {
  const v = mod.view
  if (v.kind === 'list') return false
  const scroll = contentScroll(pagingInput(), to)
  if (scroll !== (v.scroll ?? 0)) setView(io, { ...v, scroll })
  return true
}
