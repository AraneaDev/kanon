import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A temp directory whose path is already resolved through realpath.
 *
 * macOS reaches the temp directory through a symlink (`/var` -> `/private/var`),
 * so `mkdtempSync` returns a path that Kanon's own `sessionRoot` resolves
 * differently. Fixtures built on the unresolved path then fail to match the
 * resolved paths the code produces, on macOS only. Resolving once, here, keeps
 * every test comparing like with like on every platform.
 */
export function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}
