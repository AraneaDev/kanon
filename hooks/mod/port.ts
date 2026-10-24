/**
 * The engine as the mod's modules reach it. The engine follows `$` only into
 * functions declared in the hooks module itself, never across an import, and
 * refuses `$.<noun>` used as a value, so `register.tsx` builds one of these
 * from each hook's own `$` (`portOf`), spelling every call out once, and the
 * modules here take it instead of `$` (the Knossos pattern).
 *
 * Declared structurally rather than picked from the engine's typings, so the
 * modules that take a port typecheck under the repository's own `tsc` (which
 * has no `claude-code` module) and `test/pane-cli.test.ts` can import them.
 * Each member is the subset of the engine's signature the mod uses.
 */

/** A timer the clock started: `cancel()` before it fires stops it. */
export type Timer = { cancel(): void }

/** What `$.process.run` resolves with. */
export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type Port = {
  clock: {
    after(ms: number, run: () => void): Timer
    every(ms: number, run: () => void): Timer
  }
  ui: {
    open(args: { id: string; title: string; focus: true }): Promise<unknown>
    close(args: { id: string }): Promise<unknown>
    panes(): Promise<readonly { id: string }[]>
    invalidate(event: 'ui.render'): void
    log(text: string, options: { to: 'debug' }): void
  }
  session: {
    id(): Promise<string>
    cwd(): Promise<string>
    surfaces(): Promise<readonly string[]>
  }
  process: { run(argv: string[], options: { timeoutMs: number }): Promise<RunResult> }
  command: { register(args: { name: string; description: string }): Promise<unknown> }
  /** `$.env.get('HOME')`: the engine takes the variable's name only as a literal, so the port names it. */
  env: { home(): Promise<string | undefined> }
  plugin: { root: string }
}
