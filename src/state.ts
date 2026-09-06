import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { SNAPSHOT_VERSION, type Snapshot } from './drift'

/**
 * Everything here is a flat regular file directly under `state/`.
 *
 * prune() skips anything that is not a regular file and never recurses, so
 * a subdirectory under state/ would be invisible to housekeeping and would
 * grow without limit. A root contains path separators and cannot itself be
 * a filename, so it is reduced to a digest and stored inside the file too,
 * which keeps `~/.kanon/state/` debuggable by hand.
 */
function stateDir(kanonHome: string): string {
  return join(kanonHome, 'state')
}

function rootKey(root: string): string {
  return new Bun.CryptoHasher('sha256').update(root).digest('hex').slice(0, 16)
}

export function snapshotPath(kanonHome: string, root: string): string {
  return join(stateDir(kanonHome), `${rootKey(root)}.json`)
}

export function watermarkPath(kanonHome: string, session: string): string {
  return join(stateDir(kanonHome), `${session}.turn`)
}

/**
 * The last committed snapshot for a root, or null when there is no usable
 * baseline. Every failure -- absent, unreadable, malformed, or a version
 * this code does not recognise -- returns null, because "I have nothing to
 * compare against" is the honest answer to all four and the alternative is
 * announcing that the user's entire canon has changed.
 */
export function readSnapshot(kanonHome: string, root: string): Snapshot | null {
  let text: string
  try {
    text = readFileSync(snapshotPath(kanonHome, root), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const snap = parsed as Snapshot
  if (snap.v !== SNAPSHOT_VERSION || !Array.isArray(snap.files)) return null
  return snap
}

/**
 * Commit a snapshot, unless it is empty.
 *
 * A snapshot with no files is a session that recorded nothing, which is an
 * unobserved session rather than an empty canon. Writing it would make every
 * file in the next session read as `appeared`, turning a missed recording
 * into a screenful of false drift.
 *
 * Two sessions open in one repository both commit when they end, and the
 * later writer wins. That is accepted rather than locked against: the
 * snapshot describes the canon, not a session, and two sessions in one
 * repository are looking at the same canon.
 */
export function writeSnapshot(kanonHome: string, snap: Snapshot): void {
  if (snap.files.length === 0) return
  mkdirSync(stateDir(kanonHome), { recursive: true })
  writeAtomic(snapshotPath(kanonHome, snap.root), `${JSON.stringify(snap)}\n`)
}

/** Lines of the session log already examined for notices; 0 when unknown. */
export function readWatermark(kanonHome: string, session: string): number {
  const path = watermarkPath(kanonHome, session)
  if (!existsSync(path)) return 0
  try {
    const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function writeWatermark(kanonHome: string, session: string, lines: number): void {
  mkdirSync(stateDir(kanonHome), { recursive: true })
  writeAtomic(watermarkPath(kanonHome, session), `${lines}\n`)
}
