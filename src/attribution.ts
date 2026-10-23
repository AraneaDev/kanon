import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory entries, or none. A missing or unreadable directory is not an error. */
function subdirs(dir: string): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) return []
    return readdirSync(dir).sort().filter((name) => {
      try {
        // lstat, never stat: a symlinked entry is inspected as itself and
        // skipped, so the walk cannot leave the cache (same rule as prune()).
        return lstatSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/** Every `command` string anywhere in a parsed hooks.json value. */
function commands(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) commands(v, out)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'command' && typeof v === 'string') out.push(v)
      else commands(v, out)
    }
  }
}

/**
 * Stored in the index for a command that two different plugins ship. The
 * index is a Map<string, string>, so ambiguity is a sentinel value that
 * ownerOf treats as no match; a NUL cannot occur in a plugin directory name.
 */
const AMBIGUOUS = '\0ambiguous'

/**
 * Map each hook command shipped by an installed plugin to the plugin's name.
 * Reads only `<cache>/<marketplace>/<plugin>/<version>/hooks/hooks.json`.
 * A malformed or unreadable file is skipped: attribution is a courtesy and
 * must never stop a report.
 */
export function pluginIndex(pluginsCacheDir: string): Map<string, string> {
  const index = new Map<string, string>()
  for (const market of subdirs(pluginsCacheDir)) {
    for (const plugin of subdirs(join(pluginsCacheDir, market))) {
      for (const version of subdirs(join(pluginsCacheDir, market, plugin))) {
        const file = join(pluginsCacheDir, market, plugin, version, 'hooks', 'hooks.json')
        try {
          if (!lstatSync(file).isFile()) continue
          const found: string[] = []
          commands(JSON.parse(readFileSync(file, 'utf8')), found)
          for (const c of found) {
            const seen = index.get(c)
            index.set(c, seen === undefined || seen === plugin ? plugin : AMBIGUOUS)
          }
        } catch {
          // skipped
        }
      }
    }
  }
  return index
}

/** The plugin that owns a hook command: index match, then cache path, else 'unattributed'. */
export function ownerOf(command: string | null, index: Map<string, string>): string {
  if (command === null) return 'unattributed'
  const hit = index.get(command)
  if (hit !== undefined && hit !== AMBIGUOUS) return hit
  const m = /\/plugins\/cache\/[^/\s"']+\/([^/\s"']+)\//.exec(command)
  return m ? m[1] : 'unattributed'
}
