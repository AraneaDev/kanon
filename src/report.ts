import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import { classify, hasDependencySegment } from './origin'
import {
  CLAIMED_ORIGINS,
  RULESET,
  type Candidate,
  type Classified,
  type ConfigEvent,
  type Event,
  type Origin,
  type OriginDisagreement,
  type Report,
  type Skipped,
} from './types'

/** realpath, falling back to the path as given when it cannot be resolved. */
function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Run a git plumbing query and turn its exit code into a tri-state answer.
 * Exit 0/1 are git's documented "yes/no" for both check-ignore and
 * ls-files --error-unmatch. Anything else (128 for "not a git repository",
 * a missing git binary, root not existing, ...) is genuinely unknown, not a
 * confident "no" -- these flags are advisory, so an error must not be
 * reported as a definite answer.
 */
function gitStatus(path: string, root: string, args: string[]): boolean | null {
  let exitCode: number
  try {
    const proc = Bun.spawnSync(['git', '-C', root, ...args, path], { stdout: 'ignore', stderr: 'ignore' })
    exitCode = proc.exitCode
  } catch {
    return null
  }
  if (exitCode === 0) return true
  if (exitCode === 1) return false
  return null
}

function gitFlags(path: string, root: string): { gitIgnored: boolean | null; gitTracked: boolean | null } {
  return {
    gitIgnored: gitStatus(path, root, ['check-ignore', '-q']),
    gitTracked: gitStatus(path, root, ['ls-files', '--error-unmatch']),
  }
}

/**
 * Reconcile Kanon's inferred origin with Claude Code's stated `memory_type`.
 *
 * Claude Code is stating a fact about a file it just loaded; Kanon is
 * inferring one from the path. So where the claim is recognised and cannot
 * be reconciled with the inference, the claim wins the reported origin and
 * the disagreement is recorded. Two cases deliberately stay silent: an
 * unrecognised or absent claim (no evidence, not counter-evidence), and a
 * claim that merely names a broader scope than Kanon did.
 *
 * The claim only *overrides* when it names exactly one origin. A claim like
 * `Project`, which spans three, identifies that Kanon is wrong without
 * saying which of the three is right, and guessing there would trade a known
 * wrong answer for an unknown one.
 */
function reconcile(
  path: string,
  inferred: Origin,
  claimed: string | undefined,
  out: OriginDisagreement[],
): Origin {
  if (claimed === undefined) return inferred
  const compatible = CLAIMED_ORIGINS[claimed]
  if (compatible === undefined || compatible.includes(inferred)) return inferred

  out.push({ path, claimed, inferred })
  return compatible.length === 1 ? (compatible[0] as Origin) : inferred
}

export function buildReport(
  events: Event[],
  candidates: Candidate[],
  root: string,
  homeConfig: string,
  importedBy: Map<string, string>,
  skipped: Skipped[] = [],
): Report {
  const byPath = new Map(candidates.map((c) => [c.path, c]))

  // The same file loaded twice must appear once, keeping the first reason
  // seen; later reasons (e.g. a compact-triggered reload) are discarded.
  const loadedOrder: string[] = []
  const firstReason = new Map<string, string>()
  const claimedType = new Map<string, string>()
  for (const e of events) {
    if (e.ev !== 'loaded') continue
    // Resolved through realpath so the report names the file's real location
    // and `render` can express it relative to the root, which is itself real.
    // Without this a session reached through a symlink prints every path in
    // full instead of relative to the project.
    const p = realPath(resolve(root, e.path))
    if (!firstReason.has(p)) {
      firstReason.set(p, e.reason)
      loadedOrder.push(p)
    }
    // The claim is captured independently of the reason, and deliberately
    // not inside the block above. A file commonly loads more than once (a
    // compact reload is the usual second), and `memory_type` is not
    // guaranteed on any of them; tying the claim to the *first* event would
    // discard a later payload's claim whenever the first one carried none,
    // leaving the origin unchecked precisely when Claude Code did state a
    // scope. First non-null still wins, so a later contradicting claim can
    // never overwrite one already seen.
    if (e.memoryType !== null && !claimedType.has(p)) claimedType.set(p, e.memoryType)
  }

  const loaded: Classified[] = []
  const modelDisagrees: string[] = []
  const originDisagrees: OriginDisagreement[] = []
  for (const p of loadedOrder) {
    const candidate = byPath.get(p)
    // A path running through a dependency directory (vendor/, node_modules/,
    // ...) is never enumerated as a candidate BY DESIGN -- subdirCandidates
    // deliberately skips those directories -- so it is expected to be
    // unmodelled, not a failure of the reachability model. Only flag a miss
    // that the model actually got wrong: an unexpected path outside any
    // dependency directory, or one explicitly marked unreachable.
    if ((!candidate || candidate.label === 'unreachable') && !hasDependencySegment(p, root)) {
      // Kanon's candidate model was wrong about this path. That is a fault
      // in layer two, the prediction, not in layer one: origin
      // classification needs no prediction at all, so the file still gets
      // classified and still appears in `loaded`. `modelDisagrees` records
      // how much to trust `missing`/`quiet`, it does not gate what actually
      // loaded.
      modelDisagrees.push(p)
    }

    const inferred = classify(p, root, homeConfig)
    const origin = reconcile(p, inferred, claimedType.get(p), originDisagrees)
    const isForeign = origin === 'foreign'
    loaded.push({
      path: p,
      origin,
      reason: firstReason.get(p) ?? 'unknown',
      viaImport: importedBy.get(p) ?? null,
      // gitIgnored/gitTracked are advisory and only meaningful for files
      // Kanon doesn't otherwise control the origin story of.
      ...(isForeign ? gitFlags(p, root) : { gitIgnored: null, gitTracked: null }),
    })
  }

  const seen = new Set(loadedOrder)
  // Only a launch candidate that never loaded is a fault worth calling
  // missing. on-demand/path-scoped/excluded candidates are expected to stay
  // quiet unless something triggers them.
  const missing = candidates.filter((c) => c.label === 'launch' && !seen.has(c.path))
  const quiet = candidates.filter(
    (c) => (c.label === 'on-demand' || c.label === 'path-scoped' || c.label === 'excluded') && !seen.has(c.path),
  )

  const config = events.filter((e): e is ConfigEvent => e.ev === 'config')

  return { root, ruleset: RULESET, loaded, missing, quiet, config, modelDisagrees, originDisagrees, skipped }
}
