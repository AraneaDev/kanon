/**
 * The mod's module state and the transitions that keep it consistent: what
 * the pane shows (status, view, feedback, the spinner's frame), the timers
 * that move it on, and the registration's retry generation.
 *
 * Module variables, not session atoms: they live for one load of the module
 * and reset on a hot reload, which is what the pane wants. It never
 * remembers being open, so a fresh load starting from "closed" is correct.
 */
import type { Status, View } from '../lib/layout'
import type { Port, Timer } from './port'

/** The pane's id, and the `requestId` its render hook matches. */
export const PANE = 'kanon'
/** One spinner frame. */
const SPIN_MS = 100
/** How long the footer carries a feedback note (`✓ acknowledged`). */
const FEEDBACK_MS = 2_000

export const mod = {
  status: { kind: 'loading' } as Status,
  view: { kind: 'list' } as View,
  feedback: null as string | null,
  frame: 0,
  /** Whether the pane is open, as this module last saw it opened or closed. */
  open: false,
  /**
   * Bumped on every open and close: a read that lands under another number
   * belongs to a pane that has since closed (or closed and opened again), so
   * its answer is never shown as this pane's.
   */
  generation: 0,
  timers: { spinner: null as Timer | null, feedback: null as Timer | null },
  /** Single flight: one read at a time; a request during it asks for one more read after it. */
  refresh: { running: false, again: false },
  /** The runtime that started last time: `bun`, or `~/.bun/bin/bun` once a bare `bun` could not. */
  bun: null as string | null,
  registration: { registered: false, failureLogged: false, timer: null as Timer | null, generation: 0 },
}

/** Sets what the pane shows and redraws it; the spinner turns exactly while the status is loading. */
export function setStatus(io: Port, status: Status): void {
  mod.status = status
  if (status.kind === 'loading') startSpinner(io)
  else stopSpinner()
  io.ui.invalidate('ui.render')
}

/** Sets the view (the list, or one item opened in place) and redraws. */
export function setView(io: Port, view: View): void {
  mod.view = view
  io.ui.invalidate('ui.render')
}

function startSpinner(io: Port): void {
  if (mod.timers.spinner !== null) return
  try {
    mod.timers.spinner = io.clock.every(SPIN_MS, () => {
      // A status that left loading by a path that did not stop it stops it here.
      if (mod.status.kind !== 'loading' || !mod.open) return stopSpinner()
      mod.frame += 1
      io.ui.invalidate('ui.render')
    })
  } catch {
    // No clock (the session torn down): the spinner stands still, and nothing else is lost.
    mod.timers.spinner = null
  }
}

function stopSpinner(): void {
  mod.timers.spinner?.cancel()
  mod.timers.spinner = null
}

/** The footer carries `text` for two seconds, then lets it go; a newer note replaces an older one and its timer. */
export function say(io: Port, text: string): void {
  mod.timers.feedback?.cancel()
  mod.feedback = text
  io.ui.invalidate('ui.render')
  try {
    mod.timers.feedback = io.clock.after(FEEDBACK_MS, () => {
      mod.timers.feedback = null
      mod.feedback = null
      io.ui.invalidate('ui.render')
    })
  } catch {
    // Without a clock a note that stayed would lie about when it happened: drop it now instead.
    mod.timers.feedback = null
    mod.feedback = null
  }
}

/** The pane opened: it starts from the list, reading, with nothing said. */
export function paneOpened(io: Port): void {
  mod.generation += 1
  mod.open = true
  mod.view = { kind: 'list' }
  mod.feedback = null
  setStatus(io, { kind: 'loading' })
}

/** The pane closed, by the command or the person: every timer stops, and nothing about it is kept. */
export function paneClosed(): void {
  mod.generation += 1
  mod.open = false
  stopSpinner()
  mod.timers.feedback?.cancel()
  mod.timers.feedback = null
  mod.feedback = null
  mod.status = { kind: 'loading' }
  mod.view = { kind: 'list' }
  mod.refresh.again = false
}
