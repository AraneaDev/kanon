import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** claudeMdExcludes from every settings layer, merged. Later layers append. */
export function loadExcludes(root: string, homeConfig: string): string[] {
  const files = [
    join(homeConfig, 'settings.json'),
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
  ]
  const out: string[] = []
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(f, 'utf8')) as { claudeMdExcludes?: unknown }
      const list = parsed.claudeMdExcludes
      if (Array.isArray(list)) for (const g of list) if (typeof g === 'string') out.push(g)
    } catch {
      // A missing or malformed settings file contributes nothing.
    }
  }
  return out
}
