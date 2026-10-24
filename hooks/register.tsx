/**
 * The hooks module: the engine port the mod's modules reach the engine
 * through (see `mod/port.ts` for why), and the events, each wired to what
 * `mod/` does. The engine loads this file and every file it imports from the
 * plugin. A hook here never lets a throw escape into the session.
 */
import type { EngineInterface, Register } from 'claude-code'

import { layout } from './lib/layout'
import type { Action } from './lib/types'
import { reportText } from './mod/cli'
import { drawRows } from './mod/draw'
import type { Port } from './mod/port'
import { act, adoptOpenPane, endTurn, startRegistration, toggle } from './mod/session'
import { mod, PANE, paneClosed } from './mod/state'

/** The pane's height when the surface names none. */
const DEFAULT_ROWS = 40

/**
 * The engine as the mod's modules reach it, from this dispatch's `$`. The
 * engine follows `$` only into functions of this file, so every call the
 * modules make is spelled out once here.
 */
function portOf($: EngineInterface): Port {
  return {
    clock: { after: (ms, run) => $.clock.after(ms, run), every: (ms, run) => $.clock.every(ms, run) },
    ui: {
      open: args => $.ui.open(args),
      close: args => $.ui.close(args),
      panes: () => $.ui.panes(),
      invalidate: event => $.ui.invalidate(event),
      log: (text, options) => $.ui.log(text, options),
    },
    session: { id: () => $.session.id(), cwd: () => $.session.cwd(), surfaces: () => $.session.surfaces() },
    process: { run: (argv, options) => $.process.run(argv, options) },
    command: { register: args => $.command.register(args) },
    env: { home: () => $.env.get('HOME') },
    plugin: { root: $.plugin.root },
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A refused registration (no session bound yet, after a hot reload) is retried on the clock; the hook goes on regardless.
    const io = portOf($)
    await startRegistration(io).catch(() => undefined)
    // A pane left on screen across a hot reload reads the model now, not at the next turn's end.
    await adoptOpenPane(io).catch(() => undefined)
    return next(e)
  })

  // Where the session draws nowhere (`claude -p`, the SDK) there is no pane to toggle: the report is the answer.
  on('command.run', { command: 'kanon' }, async $ => {
    const io = portOf($)
    const surfaces = await $.session.surfaces().catch(() => [])
    if (surfaces.length === 0) return { text: await reportText(io) }
    await toggle(io).catch(() => undefined)
    return {}
  }).catch(() => ({}))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await endTurn(portOf($), e.agentId, e.isAborted).catch(() => undefined)
    return result
  })

  // The person's close mark, an unload, or the command: the pane's timers stop and nothing about it is kept.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && (closed as { deny?: unknown } | undefined)?.deny === undefined) paneClosed()
    return closed
  })

  // The literal is PANE: the validator reads a matcher only when it is spelled out.
  on('ui.render', { component: 'Pane', requestId: 'kanon' }, async ($, e) => {
    const io = portOf($)
    const onAction = (action: Action) => void act(io, action).catch(() => undefined)
    const frame = {
      view: mod.view,
      columns: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows ?? DEFAULT_ROWS,
      feedback: mod.feedback,
      frame: mod.frame,
    }
    // A model with a field missing can make the layout throw, and a skipped
    // render draws nothing at all. The error view says so instead, and its
    // retry reads the model again.
    try {
      return drawRows($.ui.resolve(e), layout({ ...frame, status: mod.status }), e.props.bodyColumns, onAction)
    } catch {
      const failed = layout({ ...frame, status: { kind: 'error', reason: 'kanon could not draw the pane' } })
      return drawRows($.ui.resolve(e), failed, e.props.bodyColumns, onAction)
    }
  })
}
