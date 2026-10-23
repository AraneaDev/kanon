import { IMPORT, importTarget } from './discover/imports'

export type NameKind = 'path' | 'flag' | 'script' | 'symbol'
export interface Name {
  kind: NameKind
  text: string
}

const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
// Same fence handling as parseImports. Fenced blocks hold sample output and
// illustrative snippets, which name files that were never meant to exist
// here, so reading them would report a false "gone" for each one.
const FENCED = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g
const SPAN = /`([^`\n]+)`/g
const BARE = /(?<![\w@./~:-])(?:~|\.{1,2})?(?:\/?[\w.-]+)(?:\/[\w.-]+)+\/?/g
const ONE_SHOT = /^(?:(?:bun|npm|pnpm)\s+run|yarn(?:\s+run)?)\s+([\w:.-]+)(?:\s|$)/
// yarn's own subcommands, which `yarn x` would otherwise read as a script.
const YARN_BUILTIN = new Set(['install', 'add', 'remove', 'init', 'upgrade', 'link', 'publish', 'cache', 'global', 'config'])
// A slashless span is a path only with one of these extensions: `process.env`,
// `Object.keys` and `path.join` are identifiers, and reading them as files
// would report a false "gone".
const FILE_EXT = new Set('md mdx txt json jsonc json5 yml yaml toml ini cfg conf env lock ts tsx mts cts js jsx mjs cjs sh bash zsh py rb php go rs java kt swift c h cpp hpp cs css scss html xml svg sql csv gitignore dockerignore'.split(' '))
const blank = (s: string) => s.replace(/[^\n]/g, ' ')

function fromSpan(span: string): Name | null {
  if (/^--[A-Za-z][\w-]*(=\S*)?$/.test(span)) return { kind: 'flag', text: span.split('=')[0]! }
  const run = ONE_SHOT.exec(span)
  if (run) {
    const name = run[1]!
    if (/^yarn\s/.test(span) && !/^yarn\s+run\s/.test(span) && YARN_BUILTIN.has(name)) return null
    return { kind: 'script', text: name }
  }
  if (/\s/.test(span)) return null
  if (/^https?:\/\//.test(span)) return null
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(span)
  if (span.includes('/') || (ext && FILE_EXT.has(ext[1]!.toLowerCase()))) return { kind: 'path', text: span }
  if (/^[A-Za-z_$][\w$]*(\(\))?$/.test(span)) {
    const bare = span.replace(/\(\)$/, '')
    if (bare.length >= 4 && (/[A-Z_]/.test(bare) || span.endsWith('()'))) return { kind: 'symbol', text: bare }
  }
  return null
}

/**
 * Deliberate recall trade-off: extensionless two-segment prose such as
 * `src/discover` is not taken, because it reads the same as "and/or". The
 * same name in a code span is taken, since the author marked it as a name.
 * A slash alone is not enough ("and/or", "2026/10/24"): demand a file extension, a second slash, or an anchor. */
function looksLikePath(t: string): boolean {
  if (t.includes('://')) return false
  const parts = t.split('/').filter(Boolean)
  if (parts.length < 2 && !/^[~.\/]/.test(t)) return false
  if (parts.every((p) => /^\d+$/.test(p))) return false
  const last = parts[parts.length - 1] ?? ''
  return /\.[A-Za-z0-9]{1,5}$/.test(last) || t.endsWith('/') || parts.length >= 3 || /^[~.\/]/.test(t)
}

/**
 * The paths, flags, scripts and symbols a note names, outside front matter
 * and fenced blocks, deduplicated in first-seen order.
 */
export function extractNames(markdown: string): Name[] {
  const text = markdown.replace(FRONT_MATTER, '').replace(FENCED, blank)
  const found: Array<{ at: number; name: Name }> = []

  for (const m of text.matchAll(SPAN)) {
    const name = fromSpan(m[1]!.trim())
    if (name) found.push({ at: m.index!, name })
  }

  const prose = text.replace(SPAN, blank)
  for (const m of prose.matchAll(IMPORT)) {
    const target = importTarget(m[2])
    // An @mention is not an import of anything on disk; only path-shaped
    // targets are names. Extensionless imports such as @Makefile are skipped
    // on purpose: they are indistinguishable from a mention.
    if (target && (target.includes('/') || /\.[A-Za-z0-9]{1,5}$/.test(target))) {
      found.push({ at: m.index! + m[1]!.length, name: { kind: 'path', text: target } })
    }
  }
  for (const m of prose.matchAll(BARE)) {
    const t = m[0].replace(/[.,;:!?)}\]'"]+$/, '')
    if (looksLikePath(t)) found.push({ at: m.index!, name: { kind: 'path', text: t } })
  }

  found.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const out: Name[] = []
  for (const { name } of found) {
    const key = `${name.kind}\0${name.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}
