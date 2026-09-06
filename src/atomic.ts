import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Write text to `path` without ever leaving a truncated file behind. A
 * direct writeFileSync can be interrupted mid-write by the process being
 * killed (SessionEnd's declared timeout is exactly this kind of kill), which
 * would replace a good file with a corrupt one. Writing to a sibling temp
 * file and renaming into place is atomic on the same filesystem: the final
 * path is always either the previous contents or the complete new ones.
 *
 * Shared by the report writer and the snapshot writer. A half-written
 * snapshot would be read back as drift, which is the same class of failure
 * as a truncated report and deserves the same guard.
 */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Best effort cleanup; a stray temp file is swept by prune.
    }
    throw err
  }
}
