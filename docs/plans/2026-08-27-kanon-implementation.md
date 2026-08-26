# Kanon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that records which instruction files load into a session, classifies where each came from, and names the ones that were expected and absent.

**Architecture:** A POSIX shell recorder on the hot `InstructionsLoaded` path appends raw hook payloads to a per-session JSONL. Two Bun units run cold: a Prospector that enumerates candidate instruction files for a working directory, and a Reporter that joins recorded events against those candidates, classifies origin, and renders. Origin classification needs no loader modelling; candidate enumeration does, and is quarantined so its failure degrades one section rather than the report.

**Tech Stack:** Bun 1.1+, TypeScript strict, `bun test`, POSIX shell for hooks. No runtime dependencies.

**Spec:** `docs/2026-08-27-kanon-design.md`

**Two deliberate deviations from the spec, both narrowing rather than widening:**

1. Section 5 writes the resolved candidate set to `~/.kanon/state/<id>.json`
   at `SessionStart`. This plan recomputes it at report time instead. The
   state file was an optimisation, recomputation costs milliseconds, and a
   stored set goes stale the moment a rules file is edited mid-session.
   Nothing else in the spec depends on the file existing.
2. Section 5 shows normalised events on disk. The recorder stores raw
   payloads wrapped with a timestamp, and normalisation moves to Task 7.
   Rationale is in Task 1.

## Global Constraints

- Bun 1.1 or newer. TypeScript strict. No runtime dependencies beyond Bun's standard library.
- Style: no semicolons, single quotes, 2-space indent. Matches Talanton and Nekyia.
- Kanon writes only under `~/.kanon/` and never under `~/.claude/`.
- No network calls of any kind. No telemetry. No API key.
- Kanon never blocks. `ConfigChange` can block and Kanon declines to.
- The recorder always exits 0. It must never fail a session.
- Ruleset version string is `2026-08` and appears in every report.
- Conventional Commits, lowercase after the prefix. No em dashes in prose or commit messages.
- Test files live in `test/`, named `<unit>.test.ts`.

---

### Task 1: Plugin scaffold, recorder, and the payload spike

The spec names the `InstructionsLoaded` payload as an unverified assumption. This task pins it with real data before anything is built on top.

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/hooks.json`
- Create: `hooks/scripts/record.sh`
- Create: `package.json`, `tsconfig.json`
- Create: `test/record.test.ts`
- Create: `test/fixtures/payloads/README.md`

**Interfaces:**
- Consumes: nothing
- Produces: `~/.kanon/sessions/<session_id>.jsonl` lines of shape `{"t":ISO8601,"hook":string,"raw":object}`. Every later task reads this shape.

> **Refinement against the spec.** Section 5 of the design shows normalised
> events on disk. The recorder instead stores the raw payload wrapped with a
> timestamp and hook name, and normalisation moves to the Bun side (Task 7).
> This is strictly more diagnosable: section 9 already requires storing a
> malformed payload verbatim, and storing every payload verbatim is a
> superset. Field extraction in shell would also have to be redone the moment
> Anthropic renames a field.

- [ ] **Step 1: Create the plugin manifest**

`.claude-plugin/plugin.json`:

```json
{
  "name": "kanon",
  "displayName": "Kanon",
  "version": "0.0.1",
  "description": "Reports every instruction file that governs a session, where each one came from, and the ones you expected that never loaded.",
  "author": { "name": "AraneaDev", "url": "https://github.com/AraneaDev" },
  "homepage": "https://github.com/AraneaDev/kanon",
  "repository": "https://github.com/AraneaDev/kanon",
  "license": "MIT",
  "keywords": ["claude-md", "instructions", "rules", "provenance", "hooks", "observability"]
}
```

- [ ] **Step 2: Create package.json and tsconfig.json**

`package.json`:

```json
{
  "name": "kanon",
  "version": "0.0.1",
  "description": "An instruction-load ledger with origin classification",
  "license": "MIT",
  "type": "module",
  "engines": { "bun": ">=1.1.0" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun run test"
  },
  "devDependencies": { "@types/bun": "latest", "typescript": "^5.5.0" }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@types/bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write the failing test for the recorder**

`test/record.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'hooks', 'scripts', 'record.sh')

async function record(payload: string, home: string): Promise<void> {
  const proc = Bun.spawn(['sh', SCRIPT], {
    stdin: new TextEncoder().encode(payload),
    env: { ...process.env, KANON_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  expect(proc.exitCode).toBe(0)
}

test('appends a wrapped payload to the session log', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-'))
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'InstructionsLoaded',
    cwd: '/root/aranea',
    file_path: '/root/aranea/CLAUDE.md',
    load_reason: 'session_start',
  })
  await record(payload, home)

  const file = join(home, 'sessions', 'abc123.jsonl')
  expect(existsSync(file)).toBe(true)
  const line = JSON.parse(readFileSync(file, 'utf8').trim())
  expect(line.hook).toBe('InstructionsLoaded')
  expect(line.raw.file_path).toBe('/root/aranea/CLAUDE.md')
  expect(line.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('a payload with no session id lands in unknown.jsonl and still exits 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-'))
  await record('not json at all', home)
  expect(existsSync(join(home, 'sessions', 'unknown.jsonl'))).toBe(true)
})

test('appends rather than truncating', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-'))
  const one = JSON.stringify({ session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: '/a' })
  const two = JSON.stringify({ session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: '/b' })
  await record(one, home)
  await record(two, home)
  const lines = readFileSync(join(home, 'sessions', 's.jsonl'), 'utf8').trim().split('\n')
  expect(lines.length).toBe(2)
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test test/record.test.ts`
Expected: FAIL, the script does not exist.

- [ ] **Step 5: Write the recorder**

`hooks/scripts/record.sh`:

```sh
#!/bin/sh
# Kanon hot path. Runs on every InstructionsLoaded and ConfigChange.
# One job: append the payload. It must never fail a session, so every
# failure path ends in exit 0.
set -u

payload=$(cat 2>/dev/null) || payload=''
[ -z "$payload" ] && exit 0

dir="${KANON_HOME:-$HOME/.kanon}/sessions"
mkdir -p "$dir" 2>/dev/null || exit 0

# One narrow extraction: the session id names the file, so concurrent
# sessions never interleave writes. Anything unparseable goes to unknown.
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
case "$sid" in
  ''|*/*|.*) sid='unknown' ;;
esac

hook=$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$hook" ] && hook='unknown'

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts='1970-01-01T00:00:00Z'

printf '{"t":"%s","hook":"%s","raw":%s}\n' "$ts" "$hook" "$payload" >> "$dir/$sid.jsonl" 2>/dev/null

exit 0
```

Note the `case` guard on `sid`: a payload carrying a slash or a leading dot in
`session_id` must not be able to steer the write outside the sessions
directory.

- [ ] **Step 6: Make it executable and register the hooks**

```bash
chmod +x hooks/scripts/record.sh
```

`hooks/hooks.json`:

```json
{
  "hooks": {
    "InstructionsLoaded": [
      { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/scripts/record.sh\"", "timeout": 5 } ] }
    ],
    "ConfigChange": [
      { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/scripts/record.sh\"", "timeout": 5 } ] }
    ]
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/record.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Run the payload spike**

This is the point of the task. Install the plugin locally, start one session in a directory that has a `CLAUDE.md`, read a file in a subdirectory that also has one, then inspect what actually arrived:

```bash
cat ~/.kanon/sessions/*.jsonl | head -20
```

Record the observed field names in `test/fixtures/payloads/README.md`, and save one real payload per hook event as `test/fixtures/payloads/instructions-loaded.json` and `test/fixtures/payloads/config-change.json`.

Answer two questions in that README and stop if either answer is no:

1. Does the payload carry `file_path` and `load_reason`, or different names?
2. Does `InstructionsLoaded` fire for a lazily loaded subdirectory `CLAUDE.md`, or only at launch?

If the field names differ, only Task 7's normaliser changes. If the hook does not fire lazily, the timeline in the spec's section 8 is not achievable and the design needs revisiting before Task 3.

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin hooks package.json tsconfig.json test
git commit -m "feat: record instruction-load payloads from the hot hook path"
```

---

### Task 2: Session root and origin classification

Origin classification is the highest-value output and depends on no loader modelling, so it is built first and independently.

**Files:**
- Create: `src/types.ts`
- Create: `src/origin.ts`
- Create: `test/origin.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `sessionRoot(cwd: string): string`
  - `classify(path: string, root: string, home: string): Origin`
  - `type Origin = 'managed' | 'user' | 'foreign' | 'local' | 'project'`
  - `type Label = 'launch' | 'on-demand' | 'path-scoped' | 'excluded' | 'unreachable'`
  - `interface Candidate { path: string; label: Label; rule: string }`

- [ ] **Step 1: Write the failing test**

`test/origin.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, sessionRoot } from '../src/origin'

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-o-'))
  mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
  mkdirSync(join(dir, 'repo', 'src'), { recursive: true })
  mkdirSync(join(dir, 'repo', 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(dir, 'repo', 'vendor', 'thing'), { recursive: true })
  writeFileSync(join(dir, 'repo', 'CLAUDE.md'), '')
  return dir
}

test('session root is the git root containing cwd', () => {
  const dir = tree()
  expect(sessionRoot(join(dir, 'repo', 'src'))).toBe(join(dir, 'repo'))
})

test('session root falls back to cwd outside a repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-o-'))
  expect(sessionRoot(dir)).toBe(dir)
})

test('a file under the home config directory is user scope', () => {
  const home = '/home/x/.claude'
  expect(classify('/home/x/.claude/rules/style.md', '/repo', home)).toBe('user')
})

test('a file inside node_modules is foreign', () => {
  const dir = tree()
  const root = join(dir, 'repo')
  expect(classify(join(root, 'node_modules', 'pkg', 'CLAUDE.md'), root, '/home/x/.claude')).toBe('foreign')
})

test('a file inside vendor is foreign', () => {
  const dir = tree()
  const root = join(dir, 'repo')
  expect(classify(join(root, 'vendor', 'thing', 'CLAUDE.md'), root, '/home/x/.claude')).toBe('foreign')
})

test('a file outside both the root and the home config is foreign', () => {
  expect(classify('/elsewhere/CLAUDE.md', '/repo', '/home/x/.claude')).toBe('foreign')
})

test('CLAUDE.local.md inside the root is local', () => {
  expect(classify('/repo/CLAUDE.local.md', '/repo', '/home/x/.claude')).toBe('local')
})

test('an ordinary file inside the root is project', () => {
  expect(classify('/repo/CLAUDE.md', '/repo', '/home/x/.claude')).toBe('project')
})

test('foreign wins over local, so a vendored CLAUDE.local.md is foreign', () => {
  expect(classify('/repo/vendor/a/CLAUDE.local.md', '/repo', '/home/x/.claude')).toBe('foreign')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/origin.test.ts`
Expected: FAIL, cannot resolve `../src/origin`.

- [ ] **Step 3: Write the types**

`src/types.ts`:

```ts
export type Origin = 'managed' | 'user' | 'foreign' | 'local' | 'project'

export type Label = 'launch' | 'on-demand' | 'path-scoped' | 'excluded' | 'unreachable'

export interface Candidate {
  path: string
  label: Label
  rule: string
}

export interface LoadEvent { t: string; ev: 'loaded'; path: string; reason: string }
export interface ConfigEvent { t: string; ev: 'config'; source: string; keys: string[] }
export interface UnparsedEvent { t: string; ev: 'unparsed'; raw: string }
export type Event = LoadEvent | ConfigEvent | UnparsedEvent

export interface Classified {
  path: string
  origin: Origin
  reason: string
  viaImport: string | null
  gitIgnored: boolean | null
  gitTracked: boolean | null
}

export interface Report {
  root: string
  ruleset: string
  loaded: Classified[]
  missing: Candidate[]
  quiet: Candidate[]
  config: ConfigEvent[]
  modelDisagrees: string[]
}

export const RULESET = '2026-08'

export const DEPENDENCY_SEGMENTS = [
  'node_modules', 'vendor', '.bun', '.venv', 'site-packages', '.cargo', '.gradle', 'Pods',
]
```

- [ ] **Step 4: Write the implementation**

`src/origin.ts`:

```ts
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DEPENDENCY_SEGMENTS, type Origin } from './types'

const MANAGED = {
  linux: '/etc/claude-code/CLAUDE.md',
  darwin: '/Library/Application Support/ClaudeCode/CLAUDE.md',
  win32: 'C:\\Program Files\\ClaudeCode\\CLAUDE.md',
} as const

export function managedPath(platform: string = process.platform): string {
  return MANAGED[platform as keyof typeof MANAGED] ?? MANAGED.linux
}

/** The git repository root containing cwd, or cwd when it is not in a repo. */
export function sessionRoot(cwd: string): string {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return resolve(cwd)
    dir = up
  }
}

function isUnder(path: string, parent: string): boolean {
  const p = resolve(path)
  const q = resolve(parent)
  return p === q || p.startsWith(q.endsWith(sep) ? q : q + sep)
}

function hasDependencySegment(path: string, root: string): boolean {
  const rel = isUnder(path, root) ? path.slice(root.length) : path
  return rel.split(sep).some((seg) => DEPENDENCY_SEGMENTS.includes(seg))
}

/**
 * Exactly one origin per file, first match wins. Reaching a file through an
 * import is not an origin; it is recorded separately as viaImport.
 */
export function classify(path: string, root: string, homeConfig: string): Origin {
  let p = resolve(path)
  try {
    p = realpathSync(p)
  } catch {
    // A file can be reported loaded and then removed. Classify the path as given.
  }

  if (p === managedPath()) return 'managed'
  if (isUnder(p, homeConfig)) return 'user'
  if (hasDependencySegment(p, root)) return 'foreign'
  if (!isUnder(p, root)) return 'foreign'
  if (basename(p) === 'CLAUDE.local.md') return 'local'
  return 'project'
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/origin.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/origin.ts test/origin.test.ts
git commit -m "feat: classify a loaded instruction file by where it came from"
```

---

### Task 3: Prospector, the ancestor walk and fixed scopes

**Files:**
- Create: `src/discover/walk.ts`
- Create: `test/walk.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Label` from `src/types`; `managedPath`, `sessionRoot` from `src/origin`
- Produces: `walkCandidates(cwd: string, homeConfig: string): Candidate[]`

- [ ] **Step 1: Write the failing test**

`test/walk.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkCandidates } from '../src/discover/walk'

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-w-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'pkg', 'app'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), '')
  writeFileSync(join(repo, 'CLAUDE.local.md'), '')
  writeFileSync(join(repo, '.claude', 'CLAUDE.md'), '')
  writeFileSync(join(repo, 'pkg', 'CLAUDE.md'), '')
  const home = join(dir, 'home', '.claude')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'CLAUDE.md'), '')
  return { dir, repo, home, cwd: join(repo, 'pkg', 'app') }
}

test('collects CLAUDE.md from every ancestor of cwd as launch', () => {
  const { repo, home, cwd } = tree()
  const got = walkCandidates(cwd, home)
  const byPath = new Map(got.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'CLAUDE.md'))?.label).toBe('launch')
  expect(byPath.get(join(repo, 'pkg', 'CLAUDE.md'))?.label).toBe('launch')
})

test('collects CLAUDE.local.md alongside CLAUDE.md', () => {
  const { repo, home, cwd } = tree()
  const paths = walkCandidates(cwd, home).map((c) => c.path)
  expect(paths).toContain(join(repo, 'CLAUDE.local.md'))
})

test('collects the dot-claude project file', () => {
  const { repo, home, cwd } = tree()
  const paths = walkCandidates(cwd, home).map((c) => c.path)
  expect(paths).toContain(join(repo, '.claude', 'CLAUDE.md'))
})

test('collects the user scope file as launch', () => {
  const { home, cwd } = tree()
  const byPath = new Map(walkCandidates(cwd, home).map((c) => [c.path, c]))
  expect(byPath.get(join(home, 'CLAUDE.md'))?.label).toBe('launch')
})

test('every candidate names the rule that produced it', () => {
  const { home, cwd } = tree()
  for (const c of walkCandidates(cwd, home)) expect(c.rule.length).toBeGreaterThan(0)
})

test('returns no duplicate paths', () => {
  const { home, cwd } = tree()
  const paths = walkCandidates(cwd, home).map((c) => c.path)
  expect(paths.length).toBe(new Set(paths).size)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/walk.test.ts`
Expected: FAIL, cannot resolve `../src/discover/walk`.

- [ ] **Step 3: Write the implementation**

`src/discover/walk.ts`:

```ts
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { managedPath } from '../origin'
import type { Candidate } from '../types'

const PROJECT_FILES = ['CLAUDE.md', 'CLAUDE.local.md']

/**
 * Candidates from the fixed scopes: the managed policy file, the user scope,
 * and every directory from the filesystem root down to cwd. Ordered as Claude
 * Code loads them, broadest first.
 */
export function walkCandidates(cwd: string, homeConfig: string): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()

  const push = (path: string, rule: string): void => {
    const p = resolve(path)
    if (seen.has(p) || !existsSync(p)) return
    seen.add(p)
    out.push({ path: p, label: 'launch', rule })
  }

  push(managedPath(), 'managed-policy')
  push(join(homeConfig, 'CLAUDE.md'), 'user-scope')

  // Ancestors, root first so the order matches load order.
  const chain: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    chain.unshift(dir)
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const d of chain) {
    for (const name of PROJECT_FILES) push(join(d, name), 'ancestor-walk')
    push(join(d, '.claude', 'CLAUDE.md'), 'ancestor-walk')
  }

  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/walk.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/discover/walk.ts test/walk.test.ts
git commit -m "feat: enumerate instruction candidates from the ancestor walk and fixed scopes"
```

---

### Task 4: Prospector, rules directories

**Files:**
- Create: `src/discover/rules.ts`
- Create: `test/rules.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `src/types`
- Produces: `ruleCandidates(roots: string[]): Candidate[]`, where `roots` is a list of `.claude/rules` directories

A rule with `paths:` frontmatter is labelled `path-scoped`; one without is `launch`.

- [ ] **Step 1: Write the failing test**

`test/rules.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ruleCandidates } from '../src/discover/rules'

function rulesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-r-'))
  const rules = join(dir, '.claude', 'rules')
  mkdirSync(join(rules, 'backend'), { recursive: true })
  writeFileSync(join(rules, 'style.md'), '# Style\n\nUse two spaces.\n')
  writeFileSync(join(rules, 'backend', 'api.md'), '---\npaths:\n  - "src/api/**/*.ts"\n---\n\n# API\n')
  writeFileSync(join(rules, 'notes.txt'), 'not markdown')
  return rules
}

test('discovers markdown rules recursively', () => {
  const rules = rulesDir()
  const paths = ruleCandidates([rules]).map((c) => c.path)
  expect(paths).toContain(join(rules, 'style.md'))
  expect(paths).toContain(join(rules, 'backend', 'api.md'))
})

test('ignores files that are not markdown', () => {
  const rules = rulesDir()
  const paths = ruleCandidates([rules]).map((c) => c.path)
  expect(paths).not.toContain(join(rules, 'notes.txt'))
})

test('a rule without paths frontmatter is launch', () => {
  const rules = rulesDir()
  const byPath = new Map(ruleCandidates([rules]).map((c) => [c.path, c]))
  expect(byPath.get(join(rules, 'style.md'))?.label).toBe('launch')
})

test('a rule with paths frontmatter is path-scoped', () => {
  const rules = rulesDir()
  const byPath = new Map(ruleCandidates([rules]).map((c) => [c.path, c]))
  expect(byPath.get(join(rules, 'backend', 'api.md'))?.label).toBe('path-scoped')
})

test('follows a symlinked rules subdirectory', () => {
  const rules = rulesDir()
  const other = mkdtempSync(join(tmpdir(), 'kanon-shared-'))
  writeFileSync(join(other, 'shared.md'), '# Shared\n')
  symlinkSync(other, join(rules, 'shared'))
  const names = ruleCandidates([rules]).map((c) => c.path.split('/').pop())
  expect(names).toContain('shared.md')
})

test('survives a symlink cycle without hanging', () => {
  const rules = rulesDir()
  symlinkSync(rules, join(rules, 'loop'))
  const got = ruleCandidates([rules])
  expect(got.length).toBeGreaterThan(0)
})

test('a missing rules directory yields nothing rather than throwing', () => {
  expect(ruleCandidates(['/definitely/not/here'])).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/rules.test.ts`
Expected: FAIL, cannot resolve `../src/discover/rules`.

- [ ] **Step 3: Write the implementation**

`src/discover/rules.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Candidate } from '../types'

/** True when the file opens with YAML frontmatter carrying a paths key. */
export function isPathScoped(text: string): boolean {
  if (!text.startsWith('---')) return false
  const end = text.indexOf('\n---', 3)
  if (end === -1) return false
  return /^paths\s*:/m.test(text.slice(3, end))
}

/**
 * Every .md under each rules directory, recursively, following symlinks.
 * Cycles are guarded by device and inode, so a directory is visited once.
 */
export function ruleCandidates(roots: string[]): Candidate[] {
  const out: Candidate[] = []
  const seenDirs = new Set<string>()
  const seenFiles = new Set<string>()

  const visit = (dir: string): void => {
    let st
    try {
      st = statSync(dir)
    } catch {
      return
    }
    const key = `${st.dev}:${st.ino}`
    if (seenDirs.has(key)) return
    seenDirs.add(key)

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const name of entries) {
      const full = join(dir, name)
      let est
      try {
        est = statSync(full)
      } catch {
        continue
      }
      if (est.isDirectory()) {
        visit(full)
        continue
      }
      if (!name.endsWith('.md')) continue
      const p = resolve(full)
      if (seenFiles.has(p)) continue
      seenFiles.add(p)

      let text = ''
      try {
        text = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      out.push({
        path: p,
        label: isPathScoped(text) ? 'path-scoped' : 'launch',
        rule: 'rules-dir',
      })
    }
  }

  for (const r of roots) visit(r)
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/rules.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/discover/rules.ts test/rules.test.ts
git commit -m "feat: discover rules directories recursively and label path-scoped rules"
```

---

### Task 5: Prospector, imports

**Files:**
- Create: `src/discover/imports.ts`
- Create: `test/imports.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `parseImports(text: string): string[]` returning raw `@path` targets, code spans and fences excluded
  - `resolveImports(files: string[], maxDepth?: number): Map<string, string>` mapping each imported file's absolute path to the absolute path of the file that imported it. Default `maxDepth` is 4.

- [ ] **Step 1: Write the failing test**

`test/imports.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseImports, resolveImports } from '../src/discover/imports'

test('finds a bare import', () => {
  expect(parseImports('See @docs/git.md for detail')).toEqual(['docs/git.md'])
})

test('ignores an import inside a code span', () => {
  expect(parseImports('Write `@README` to mention it')).toEqual([])
})

test('ignores an import inside a fenced block', () => {
  const text = '```\n@docs/nope.md\n```\n@docs/yes.md\n'
  expect(parseImports(text)).toEqual(['docs/yes.md'])
})

test('finds a home-relative import', () => {
  expect(parseImports('- @~/.claude/mine.md')).toEqual(['~/.claude/mine.md'])
})

test('resolves relative to the importing file, not the cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'CLAUDE.md'), 'see @child.md\n')
  writeFileSync(join(dir, 'child.md'), 'leaf\n')
  const got = resolveImports([join(dir, 'CLAUDE.md')])
  expect(got.get(join(dir, 'child.md'))).toBe(join(dir, 'CLAUDE.md'))
})

test('follows a chain to depth four', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@c.md\n')
  writeFileSync(join(dir, 'c.md'), '@d.md\n')
  writeFileSync(join(dir, 'd.md'), '@e.md\n')
  writeFileSync(join(dir, 'e.md'), 'leaf\n')
  const got = resolveImports([join(dir, 'a.md')])
  expect(got.has(join(dir, 'd.md'))).toBe(true)
})

test('stops after four hops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@c.md\n')
  writeFileSync(join(dir, 'c.md'), '@d.md\n')
  writeFileSync(join(dir, 'd.md'), '@e.md\n')
  writeFileSync(join(dir, 'e.md'), '@f.md\n')
  writeFileSync(join(dir, 'f.md'), 'too far\n')
  const got = resolveImports([join(dir, 'a.md')])
  expect(got.has(join(dir, 'f.md'))).toBe(false)
})

test('survives an import cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@b.md\n')
  writeFileSync(join(dir, 'b.md'), '@a.md\n')
  const got = resolveImports([join(dir, 'a.md')])
  expect(got.has(join(dir, 'b.md'))).toBe(true)
})

test('ignores an import target that does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-i-'))
  writeFileSync(join(dir, 'a.md'), '@ghost.md\n')
  expect(resolveImports([join(dir, 'a.md')]).size).toBe(0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/imports.test.ts`
Expected: FAIL, cannot resolve `../src/discover/imports`.

- [ ] **Step 3: Write the implementation**

`src/discover/imports.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

const IMPORT = /(^|\s)@([^\s`]+)/g

/** Import targets in a file, with code spans and fenced blocks removed first. */
export function parseImports(text: string): string[] {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')

  const out: string[] = []
  for (const m of stripped.matchAll(IMPORT)) {
    const target = m[2]
    if (target) out.push(target)
  }
  return out
}

function resolveTarget(target: string, importer: string): string {
  if (target.startsWith('~/')) return resolve(homedir(), target.slice(2))
  if (isAbsolute(target)) return resolve(target)
  return resolve(dirname(importer), target)
}

/**
 * Walk the import graph breadth-first from the given files. Returns each
 * imported file mapped to the file that imported it. Claude Code allows four
 * hops, so the seed files are depth 0 and depth 4 is the last followed.
 */
export function resolveImports(files: string[], maxDepth = 4): Map<string, string> {
  const found = new Map<string, string>()
  const visited = new Set<string>(files.map((f) => resolve(f)))
  let frontier = files.map((f) => resolve(f))

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const importer of frontier) {
      let text = ''
      try {
        text = readFileSync(importer, 'utf8')
      } catch {
        continue
      }
      for (const target of parseImports(text)) {
        const p = resolveTarget(target, importer)
        if (!existsSync(p)) continue
        if (!found.has(p)) found.set(p, importer)
        if (visited.has(p)) continue
        visited.add(p)
        next.push(p)
      }
    }
    frontier = next
  }

  return found
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/imports.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/discover/imports.ts test/imports.test.ts
git commit -m "feat: follow claude.md imports to depth four, skipping code blocks"
```

---

### Task 6: Prospector, excludes and the assembled candidate set

**Files:**
- Create: `src/discover/excludes.ts`
- Create: `src/discover/index.ts`
- Create: `test/discover.test.ts`

**Interfaces:**
- Consumes: `walkCandidates`, `ruleCandidates`, `resolveImports`, `sessionRoot`, `Candidate`
- Produces:
  - `loadExcludes(cwd: string, homeConfig: string): string[]`
  - `discover(cwd: string, homeConfig: string): { root: string; candidates: Candidate[] }`

`discover` applies `claudeMdExcludes` last, relabelling a matched candidate as `excluded` rather than dropping it, so the report can say why something is absent.

- [ ] **Step 1: Write the failing test**

`test/discover.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, loadExcludes } from '../src/discover'

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-d-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), 'see @docs/extra.md\n')
  writeFileSync(join(repo, 'docs', 'extra.md'), '# Extra\n')
  writeFileSync(join(repo, 'docs', 'CLAUDE.md'), '# Docs\n')
  writeFileSync(join(repo, '.claude', 'rules', 'style.md'), '# Style\n')
  writeFileSync(join(repo, 'node_modules', 'pkg', 'CLAUDE.md'), '# Vendor\n')
  const home = join(dir, 'home', '.claude')
  mkdirSync(home, { recursive: true })
  return { repo, home }
}

test('merges excludes across settings layers', () => {
  const { repo, home } = project()
  mkdirSync(join(home), { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/a.md'] }))
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/b.md'] }))
  const got = loadExcludes(repo, home)
  expect(got).toContain('**/a.md')
  expect(got).toContain('**/b.md')
})

test('the assembled set includes the project file and the rule', () => {
  const { repo, home } = project()
  const { candidates } = discover(repo, home)
  const paths = candidates.map((c) => c.path)
  expect(paths).toContain(join(repo, 'CLAUDE.md'))
  expect(paths).toContain(join(repo, '.claude', 'rules', 'style.md'))
})

test('a subdirectory file is on-demand rather than launch', () => {
  const { repo, home } = project()
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'docs', 'CLAUDE.md'))?.label).toBe('on-demand')
})

test('dependency directories are skipped during the subdirectory walk', () => {
  const { repo, home } = project()
  const paths = discover(repo, home).candidates.map((c) => c.path)
  expect(paths).not.toContain(join(repo, 'node_modules', 'pkg', 'CLAUDE.md'))
})

test('an imported file becomes a launch candidate', () => {
  const { repo, home } = project()
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, 'docs', 'extra.md'))?.label).toBe('launch')
})

test('an excluded candidate is relabelled rather than dropped', () => {
  const { repo, home } = project()
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/rules/style.md'] }))
  const byPath = new Map(discover(repo, home).candidates.map((c) => [c.path, c]))
  expect(byPath.get(join(repo, '.claude', 'rules', 'style.md'))?.label).toBe('excluded')
})

test('the root is the git root', () => {
  const { repo, home } = project()
  expect(discover(repo, home).root).toBe(repo)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/discover.test.ts`
Expected: FAIL, cannot resolve `../src/discover`.

- [ ] **Step 3: Write the excludes loader**

`src/discover/excludes.ts`:

```ts
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
```

- [ ] **Step 4: Write the assembler**

`src/discover/index.ts`:

```ts
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sessionRoot } from '../origin'
import { DEPENDENCY_SEGMENTS, type Candidate } from '../types'
import { resolveImports } from './imports'
import { ruleCandidates } from './rules'
import { walkCandidates } from './walk'
import { loadExcludes } from './excludes'

export { loadExcludes }

const SUBDIR_FILES = ['CLAUDE.md', 'CLAUDE.local.md']

/**
 * CLAUDE.md below cwd. Dependency directories and dot-directories are skipped
 * to bound the walk; a load observed inside one is still classified and
 * reported, so skipping them costs no visibility.
 */
function subdirCandidates(root: string): Candidate[] {
  const out: Candidate[] = []
  const visit = (dir: string, depth: number): void => {
    if (depth > 8) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (DEPENDENCY_SEGMENTS.includes(name)) continue
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        visit(full, depth + 1)
      } else if (SUBDIR_FILES.includes(name)) {
        out.push({ path: resolve(full), label: 'on-demand', rule: 'subdirectory' })
      }
    }
  }
  for (const name of readdirSafe(root)) {
    if (DEPENDENCY_SEGMENTS.includes(name) || name.startsWith('.')) continue
    const full = join(root, name)
    try {
      if (statSync(full).isDirectory()) visit(full, 1)
    } catch {
      continue
    }
  }
  return out
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function discover(cwd: string, homeConfig: string): { root: string; candidates: Candidate[] } {
  const root = sessionRoot(cwd)

  const base = walkCandidates(cwd, homeConfig)
  const rules = ruleCandidates([join(homeConfig, 'rules'), join(root, '.claude', 'rules')])
  const subs = subdirCandidates(root)

  const launchPaths = [...base, ...rules].filter((c) => c.label === 'launch').map((c) => c.path)
  const imported = resolveImports(launchPaths)
  const importCandidates: Candidate[] = [...imported.keys()].map((p) => ({
    path: p,
    label: 'launch',
    rule: 'import',
  }))

  const merged = new Map<string, Candidate>()
  for (const c of [...base, ...rules, ...importCandidates, ...subs]) {
    if (!merged.has(c.path)) merged.set(c.path, c)
  }

  const excludes = loadExcludes(root, homeConfig)
  const candidates = [...merged.values()].map((c) =>
    excludes.some((g) => new Bun.Glob(g).match(c.path)) ? { ...c, label: 'excluded' as const } : c,
  )

  return { root, candidates }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/discover.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/discover test/discover.test.ts
git commit -m "feat: assemble the candidate set and apply claudemdexcludes"
```

---

### Task 7: Reporter, normalisation and the join

**Files:**
- Create: `src/normalise.ts`
- Create: `src/report.ts`
- Create: `test/report.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Classified`, `Report`, `Event`, `RULESET`, `classify`
- Produces:
  - `normalise(lines: string[]): Event[]`
  - `buildReport(events: Event[], candidates: Candidate[], root: string, homeConfig: string, importedBy: Map<string, string>): Report`

Field names in `normalise` come from the Task 1 spike. If the spike found different names, this is the only place that changes.

- [ ] **Step 1: Write the failing test**

`test/report.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { buildReport } from '../src/report'
import { normalise } from '../src/normalise'
import type { Candidate } from '../src/types'

const HOME = '/home/x/.claude'
const ROOT = '/repo'

function line(file: string, reason = 'session_start'): string {
  return JSON.stringify({
    t: '2026-08-27T00:00:00Z',
    hook: 'InstructionsLoaded',
    raw: { session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: file, load_reason: reason },
  })
}

test('normalise turns wrapped payloads into load events', () => {
  const got = normalise([line('/repo/CLAUDE.md')])
  expect(got).toEqual([{ t: '2026-08-27T00:00:00Z', ev: 'loaded', path: '/repo/CLAUDE.md', reason: 'session_start' }])
})

test('normalise turns a config change into a config event', () => {
  const raw = JSON.stringify({
    t: '2026-08-27T00:01:00Z',
    hook: 'ConfigChange',
    raw: { hook_event_name: 'ConfigChange', config_source: 'skills', changed_keys: ['a'] },
  })
  expect(normalise([raw])).toEqual([{ t: '2026-08-27T00:01:00Z', ev: 'config', source: 'skills', keys: ['a'] }])
})

test('normalise keeps an unparseable line rather than dropping it', () => {
  const got = normalise(['{ not json'])
  expect(got[0]?.ev).toBe('unparsed')
})

test('a launch candidate that never loaded is missing', () => {
  const candidates: Candidate[] = [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }]
  const r = buildReport([], candidates, ROOT, HOME, new Map())
  expect(r.missing.map((c) => c.path)).toEqual(['/repo/.claude/rules/testing.md'])
})

test('an on-demand candidate that never loaded is quiet, not missing', () => {
  const candidates: Candidate[] = [{ path: '/repo/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' }]
  const r = buildReport([], candidates, ROOT, HOME, new Map())
  expect(r.missing).toEqual([])
  expect(r.quiet.map((c) => c.path)).toEqual(['/repo/docs/CLAUDE.md'])
})

test('a loaded file is classified and carries its reason', () => {
  const candidates: Candidate[] = [{ path: '/repo/CLAUDE.md', label: 'launch', rule: 'ancestor-walk' }]
  const r = buildReport(normalise([line('/repo/CLAUDE.md')]), candidates, ROOT, HOME, new Map())
  expect(r.loaded[0]?.origin).toBe('project')
  expect(r.loaded[0]?.reason).toBe('session_start')
})

test('a load with no matching candidate is recorded as model disagreement', () => {
  const r = buildReport(normalise([line('/elsewhere/CLAUDE.md')]), [], ROOT, HOME, new Map())
  expect(r.modelDisagrees).toEqual(['/elsewhere/CLAUDE.md'])
})

test('a load labelled unreachable is also a model disagreement', () => {
  const candidates: Candidate[] = [{ path: '/repo/odd.md', label: 'unreachable', rule: 'none' }]
  const r = buildReport(normalise([line('/repo/odd.md')]), candidates, ROOT, HOME, new Map())
  expect(r.modelDisagrees).toEqual(['/repo/odd.md'])
})

test('an import flag is carried onto the loaded entry', () => {
  const candidates: Candidate[] = [{ path: '/repo/docs/extra.md', label: 'launch', rule: 'import' }]
  const importedBy = new Map([['/repo/docs/extra.md', '/repo/CLAUDE.md']])
  const r = buildReport(normalise([line('/repo/docs/extra.md')]), candidates, ROOT, HOME, importedBy)
  expect(r.loaded[0]?.viaImport).toBe('/repo/CLAUDE.md')
})

test('the ruleset version is stamped on every report', () => {
  expect(buildReport([], [], ROOT, HOME, new Map()).ruleset).toBe('2026-08')
})

test('the same file loaded twice appears once', () => {
  const candidates: Candidate[] = [{ path: '/repo/CLAUDE.md', label: 'launch', rule: 'ancestor-walk' }]
  const events = normalise([line('/repo/CLAUDE.md'), line('/repo/CLAUDE.md', 'compact')])
  expect(buildReport(events, candidates, ROOT, HOME, new Map()).loaded.length).toBe(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/report.test.ts`
Expected: FAIL, cannot resolve `../src/report`.

- [ ] **Step 3: Write the normaliser**

`src/normalise.ts`:

```ts
import type { Event } from './types'

interface Wrapped {
  t?: string
  hook?: string
  raw?: Record<string, unknown>
}

/**
 * Turn recorder lines into events. Field names come from the payload spike in
 * Task 1; if Anthropic renames a field, this function is the only thing that
 * changes.
 */
export function normalise(lines: string[]): Event[] {
  const out: Event[] = []
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue

    let w: Wrapped
    try {
      w = JSON.parse(text) as Wrapped
    } catch {
      out.push({ t: '', ev: 'unparsed', raw: text })
      continue
    }

    const t = typeof w.t === 'string' ? w.t : ''
    const raw = w.raw
    if (!raw || typeof raw !== 'object') {
      out.push({ t, ev: 'unparsed', raw: text })
      continue
    }

    if (w.hook === 'InstructionsLoaded') {
      const path = raw.file_path
      if (typeof path !== 'string') {
        out.push({ t, ev: 'unparsed', raw: text })
        continue
      }
      const reason = typeof raw.load_reason === 'string' ? raw.load_reason : 'unknown'
      out.push({ t, ev: 'loaded', path, reason })
      continue
    }

    if (w.hook === 'ConfigChange') {
      const source = typeof raw.config_source === 'string' ? raw.config_source : 'unknown'
      const keys = Array.isArray(raw.changed_keys) ? raw.changed_keys.filter((k): k is string => typeof k === 'string') : []
      out.push({ t, ev: 'config', source, keys })
      continue
    }

    out.push({ t, ev: 'unparsed', raw: text })
  }
  return out
}
```

- [ ] **Step 4: Write the report builder**

`src/report.ts`:

```ts
import { resolve } from 'node:path'
import { classify } from './origin'
import { RULESET, type Candidate, type Classified, type ConfigEvent, type Event, type Report } from './types'

function gitFlags(path: string, root: string): { gitIgnored: boolean | null; gitTracked: boolean | null } {
  const run = (args: string[]): number | null => {
    try {
      const p = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'ignore', stderr: 'ignore' })
      return p.exitCode
    } catch {
      return null
    }
  }
  const ignored = run(['check-ignore', '-q', path])
  const tracked = run(['ls-files', '--error-unmatch', path])
  return {
    gitIgnored: ignored === null ? null : ignored === 0,
    gitTracked: tracked === null ? null : tracked === 0,
  }
}

export function buildReport(
  events: Event[],
  candidates: Candidate[],
  root: string,
  homeConfig: string,
  importedBy: Map<string, string>,
): Report {
  const byPath = new Map(candidates.map((c) => [c.path, c]))

  const loadedOrder: string[] = []
  const firstReason = new Map<string, string>()
  for (const e of events) {
    if (e.ev !== 'loaded') continue
    const p = resolve(e.path)
    if (!firstReason.has(p)) {
      firstReason.set(p, e.reason)
      loadedOrder.push(p)
    }
  }

  const loaded: Classified[] = []
  const modelDisagrees: string[] = []
  for (const p of loadedOrder) {
    const candidate = byPath.get(p)
    if (!candidate || candidate.label === 'unreachable') modelDisagrees.push(p)
    const isForeign = classify(p, root, homeConfig) === 'foreign'
    loaded.push({
      path: p,
      origin: classify(p, root, homeConfig),
      reason: firstReason.get(p) ?? 'unknown',
      viaImport: importedBy.get(p) ?? null,
      ...(isForeign ? gitFlags(p, root) : { gitIgnored: null, gitTracked: null }),
    })
  }

  const seen = new Set(loadedOrder)
  const missing = candidates.filter((c) => c.label === 'launch' && !seen.has(c.path))
  const quiet = candidates.filter(
    (c) => (c.label === 'on-demand' || c.label === 'path-scoped' || c.label === 'excluded') && !seen.has(c.path),
  )

  const config = events.filter((e): e is ConfigEvent => e.ev === 'config')

  return { root, ruleset: RULESET, loaded, missing, quiet, config, modelDisagrees }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/report.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/normalise.ts src/report.ts test/report.test.ts
git commit -m "feat: join recorded loads against candidates and flag model disagreement"
```

---

### Task 8: Renderer

**Files:**
- Create: `src/render.ts`
- Create: `test/render.test.ts`

**Interfaces:**
- Consumes: `Report`, `Classified` from `src/types`
- Produces: `render(report: Report): string`

- [ ] **Step 1: Write the failing test**

`test/render.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { render } from '../src/render'
import type { Report } from '../src/types'

function base(): Report {
  return { root: '/repo', ruleset: '2026-08', loaded: [], missing: [], quiet: [], config: [], modelDisagrees: [] }
}

test('names the root and the ruleset', () => {
  const out = render(base())
  expect(out).toContain('/repo')
  expect(out).toContain('2026-08')
})

test('marks a foreign load in upper case so it cannot be skimmed past', () => {
  const r = base()
  r.loaded = [{ path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false }]
  expect(render(r)).toContain('FOREIGN')
})

test('says an untracked foreign file is untracked', () => {
  const r = base()
  r.loaded = [{ path: '/repo/vendor/p/CLAUDE.md', origin: 'foreign', reason: 'nested_traversal', viaImport: null, gitIgnored: false, gitTracked: false }]
  expect(render(r)).toContain('untracked')
})

test('lists a missing launch candidate under NOT LOADED', () => {
  const r = base()
  r.missing = [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }]
  const out = render(r)
  expect(out).toContain('NOT LOADED')
  expect(out).toContain('missing')
})

test('describes a quiet candidate as not triggered rather than as a fault', () => {
  const r = base()
  r.quiet = [{ path: '/repo/docs/CLAUDE.md', label: 'on-demand', rule: 'subdirectory' }]
  const out = render(r)
  expect(out).toContain('not triggered')
  expect(out).not.toContain('missing')
})

test('warns when the reachability model disagrees with reality', () => {
  const r = base()
  r.modelDisagrees = ['/odd/CLAUDE.md']
  expect(render(r)).toContain('reachability model disagrees')
})

test('renders a config change', () => {
  const r = base()
  r.config = [{ t: '2026-08-27T00:52:00Z', ev: 'config', source: 'skills', keys: ['a', 'b'] }]
  const out = render(r)
  expect(out).toContain('CONFIG CHANGED')
  expect(out).toContain('skills')
})

test('a clean session still renders without throwing', () => {
  expect(render(base()).length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/render.test.ts`
Expected: FAIL, cannot resolve `../src/render`.

- [ ] **Step 3: Write the implementation**

`src/render.ts`:

```ts
import { relative } from 'node:path'
import type { Classified, Report } from './types'

function short(path: string, root: string): string {
  const rel = relative(root, path)
  return rel && !rel.startsWith('..') ? rel : path
}

function loadedLine(c: Classified, root: string): string {
  const tag = c.origin === 'foreign' ? 'FOREIGN' : c.origin
  const main = `  ${tag.padEnd(10)} ${short(c.path, root).padEnd(38)} ${c.reason}`
  const notes: string[] = []
  if (c.viaImport) notes.push(`imported by ${short(c.viaImport, root)}`)
  if (c.origin === 'foreign') {
    notes.push(c.gitTracked === false ? 'untracked in this repo' : 'tracked in this repo')
    if (c.gitIgnored === true) notes.push('git-ignored')
  }
  return notes.length > 0 ? `${main}\n${' '.repeat(13)}${notes.join(', ')}` : main
}

export function render(report: Report): string {
  const { root, ruleset } = report
  const out: string[] = []

  out.push(`SESSION  ${root}${' '.repeat(Math.max(1, 26 - root.length))}ruleset ${ruleset}`)
  out.push('')

  out.push('LOADED')
  if (report.loaded.length === 0) out.push('  nothing recorded')
  for (const c of report.loaded) out.push(loadedLine(c, root))

  if (report.missing.length > 0 || report.quiet.length > 0) {
    out.push('')
    out.push('NOT LOADED')
    for (const c of report.missing) {
      out.push(`  missing    ${short(c.path, root).padEnd(38)} expected at launch`)
    }
    for (const c of report.quiet) {
      const why =
        c.label === 'on-demand' ? 'on-demand, not triggered'
        : c.label === 'path-scoped' ? 'path-scoped, not triggered'
        : 'excluded by claudeMdExcludes'
      out.push(`  quiet      ${short(c.path, root).padEnd(38)} ${why}`)
    }
  }

  if (report.config.length > 0) {
    out.push('')
    out.push('CONFIG CHANGED')
    for (const e of report.config) {
      out.push(`  ${e.t.slice(11, 16)}  ${e.source}  (+${e.keys.length})`)
    }
  }

  if (report.modelDisagrees.length > 0) {
    out.push('')
    out.push('NOTE  my reachability model disagrees with reality for:')
    for (const p of report.modelDisagrees) out.push(`  ${short(p, root)}`)
    out.push('  The NOT LOADED section is unreliable for this session.')
  }

  return out.join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/render.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts test/render.test.ts
git commit -m "feat: render the session report"
```

---

### Task 9: Wire the cold path, the alarms, and the command

**Files:**
- Create: `src/cli.ts`
- Create: `hooks/scripts/session-start.sh`
- Create: `hooks/scripts/session-end.sh`
- Create: `commands/kanon.md`
- Modify: `hooks/hooks.json`
- Create: `test/cli.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `discover`, `normalise`, `buildReport`, `render`, `resolveImports`
- Produces: `kanon report --session <id> [--cwd <path>]` printing the rendered report to stdout, and `kanon alarm --session <id> --cwd <path>` printing only the unprompted lines, empty when there is nothing to say.

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

async function run(args: string[], env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(['bun', CLI, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

function seeded() {
  const home = mkdtempSync(join(tmpdir(), 'kanon-cli-'))
  const repo = join(home, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'vendor', 'p'), { recursive: true })
  writeFileSync(join(repo, 'CLAUDE.md'), '')
  writeFileSync(join(repo, 'vendor', 'p', 'CLAUDE.md'), '')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const wrap = (f: string, reason: string) =>
    JSON.stringify({ t: '2026-08-27T00:00:00Z', hook: 'InstructionsLoaded', raw: { session_id: 's', hook_event_name: 'InstructionsLoaded', file_path: f, load_reason: reason } })
  writeFileSync(join(sessions, 's.jsonl'), [wrap(join(repo, 'CLAUDE.md'), 'session_start'), wrap(join(repo, 'vendor', 'p', 'CLAUDE.md'), 'nested_traversal')].join('\n') + '\n')
  return { home, repo }
}

test('report prints the loaded set', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('LOADED')
  expect(out).toContain('CLAUDE.md')
})

test('report flags the vendored file as foreign', async () => {
  const { home, repo } = seeded()
  const out = await run(['report', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out).toContain('FOREIGN')
})

test('alarm speaks when a foreign file loaded', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--session', 's', '--cwd', repo], { KANON_HOME: home })
  expect(out.trim().length).toBeGreaterThan(0)
  expect(out).toContain('foreign')
})

test('alarm is silent for an unknown session', async () => {
  const { home, repo } = seeded()
  const out = await run(['alarm', '--session', 'nope', '--cwd', repo], { KANON_HOME: home })
  expect(out.trim()).toBe('')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL, cannot resolve `src/cli.ts`.

- [ ] **Step 3: Write the CLI**

`src/cli.ts`:

```ts
#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discover } from './discover'
import { resolveImports } from './discover/imports'
import { normalise } from './normalise'
import { render } from './render'
import { buildReport } from './report'
import type { Report } from './types'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function kanonHome(): string {
  return process.env.KANON_HOME ?? join(homedir(), '.kanon')
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

function collect(session: string, cwd: string): Report {
  const file = join(kanonHome(), 'sessions', `${session}.jsonl`)
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const events = normalise(lines)

  const home = claudeHome()
  const { root, candidates } = discover(cwd, home)
  const launch = candidates.filter((c) => c.label === 'launch').map((c) => c.path)
  const importedBy = resolveImports(launch)

  return buildReport(events, candidates, root, home, importedBy)
}

const command = process.argv[2] ?? 'report'
const session = arg('session') ?? 'unknown'
const cwd = arg('cwd') ?? process.cwd()

if (command === 'report') {
  const report = collect(session, cwd)
  const text = render(report)
  console.log(text)
  const dir = join(kanonHome(), 'reports')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${session}.txt`), text + '\n')
  } catch {
    // A report that cannot be written is still a report that was printed.
  }
} else if (command === 'alarm') {
  const report = collect(session, cwd)
  const foreign = report.loaded.filter((c) => c.origin === 'foreign')
  const lines: string[] = []
  for (const c of foreign) lines.push(`kanon: foreign instruction file loaded: ${c.path}`)
  for (const c of report.missing) lines.push(`kanon: expected at launch but never loaded: ${c.path}`)
  if (lines.length > 0) console.log(lines.join('\n'))
} else {
  console.log('usage: kanon [report|alarm] --session <id> [--cwd <path>]')
}
```

- [ ] **Step 4: Write the session hooks**

`hooks/scripts/session-end.sh`:

```sh
#!/bin/sh
# Cold path. Renders the report, or leaves the raw log if it cannot.
set -u
payload=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$sid" ] && exit 0
command -v bun >/dev/null 2>&1 || exit 0
bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" report --session "$sid" --cwd "${cwd:-$PWD}" >/dev/null 2>&1
exit 0
```

`hooks/scripts/session-start.sh`:

```sh
#!/bin/sh
# Cold path. Emits the alarm lines, if any, as a systemMessage.
set -u
payload=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -z "$sid" ] && exit 0
command -v bun >/dev/null 2>&1 || exit 0
msg=$(bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" alarm --session "$sid" --cwd "${cwd:-$PWD}" 2>/dev/null)
[ -z "$msg" ] && exit 0
printf '{"systemMessage":%s}\n' "$(printf '%s' "$msg" | bun -e 'console.log(JSON.stringify(await Bun.stdin.text()))' 2>/dev/null || printf '""')"
exit 0
```

```bash
chmod +x hooks/scripts/session-start.sh hooks/scripts/session-end.sh
```

- [ ] **Step 5: Register the session hooks**

Replace `hooks/hooks.json` with:

```json
{
  "hooks": {
    "InstructionsLoaded": [
      { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/scripts/record.sh\"", "timeout": 5 } ] }
    ],
    "ConfigChange": [
      { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/scripts/record.sh\"", "timeout": 5 } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/scripts/session-start.sh\"", "timeout": 10 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/scripts/session-end.sh\"", "timeout": 5 } ] }
    ]
  }
}
```

The `SessionEnd` timeout of 5 is deliberate. That event shares a 1.5 second
budget across every hook on the machine unless a hook declares longer, and
the spec requires Kanon to raise it rather than emit a partial report.

- [ ] **Step 6: Write the slash command**

`commands/kanon.md`:

```markdown
---
description: Report which instruction files govern this session and where each came from
---

Run the Kanon report for the current session and show the user the output verbatim.

Use Bash to run:

```
bun "$CLAUDE_PLUGIN_ROOT/src/cli.ts" report --session "$CLAUDE_SESSION_ID" --cwd "$PWD"
```

Print the result exactly as it comes back. Do not summarise it, reorder it, or
drop rows: the alignment carries meaning and a dropped row is the row that
mattered.

If the command prints nothing, say that no instruction loads were recorded for
this session and that Kanon only sees sessions started after it was installed.

If `bun` is not found, tell the user Kanon needs Bun 1.1 or newer and that the
raw event log is still being written to `~/.kanon/sessions/`.
```

- [ ] **Step 7: Run the whole suite**

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Write the README**

Write `README.md` covering: what Kanon answers, the three origins that matter
(`user`, `project`, `foreign`), installation, the `/kanon` command, where data
lives (`~/.kanon/`), the ruleset version and what it means when it goes stale,
and a plain statement that Kanon never blocks and makes no network calls.

Follow the house writing style: no em dashes, one author writing as I, the
reader addressed as you.

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts hooks commands README.md test/cli.test.ts
git commit -m "feat: report on demand, warn on a foreign load, and write at session end"
```

---

### Task 10: Size limits and retention

Two spec requirements with no home in the tasks above. Section 9 requires
skipping files over 4 MiB, matching Claude Code's own limit, and section 5
requires pruning events, state and reports older than 90 days.

**Files:**
- Create: `src/limits.ts`
- Modify: `src/discover/rules.ts` (use the size guard before reading)
- Modify: `src/cli.ts` (prune on every run)
- Create: `test/limits.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `MAX_FILE_BYTES = 4 * 1024 * 1024`
  - `tooLarge(path: string): boolean`
  - `prune(kanonHome: string, now: number, maxAgeDays?: number): string[]` returning the paths removed. Default `maxAgeDays` is 90.

- [ ] **Step 1: Write the failing test**

`test/limits.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FILE_BYTES, prune, tooLarge } from '../src/limits'

test('a small file is not too large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-l-'))
  const f = join(dir, 'small.md')
  writeFileSync(f, 'hello')
  expect(tooLarge(f)).toBe(false)
})

test('a file over the limit is too large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-l-'))
  const f = join(dir, 'big.md')
  writeFileSync(f, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  expect(tooLarge(f)).toBe(true)
})

test('a missing file is not too large', () => {
  expect(tooLarge('/definitely/not/here.md')).toBe(false)
})

test('prune removes files older than the cutoff', () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const old = join(home, 'sessions', 'old.jsonl')
  writeFileSync(old, '{}')
  const longAgo = new Date('2020-01-01T00:00:00Z')
  utimesSync(old, longAgo, longAgo)
  const removed = prune(home, Date.now())
  expect(removed).toContain(old)
  expect(existsSync(old)).toBe(false)
})

test('prune keeps recent files', () => {
  const home = mkdtempSync(join(tmpdir(), 'kanon-p-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const fresh = join(home, 'sessions', 'fresh.jsonl')
  writeFileSync(fresh, '{}')
  prune(home, Date.now())
  expect(existsSync(fresh)).toBe(true)
})

test('prune on a missing directory returns nothing rather than throwing', () => {
  expect(prune('/definitely/not/here', Date.now())).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/limits.test.ts`
Expected: FAIL, cannot resolve `../src/limits`.

- [ ] **Step 3: Write the implementation**

`src/limits.ts`:

```ts
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Claude Code loads a CLAUDE.md up to 4 MiB and skips a larger one. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

export function tooLarge(path: string): boolean {
  try {
    return statSync(path).size > MAX_FILE_BYTES
  } catch {
    return false
  }
}

const PRUNED_DIRS = ['sessions', 'state', 'reports']

/** Remove events, state and reports older than maxAgeDays. Returns what went. */
export function prune(kanonHome: string, now: number, maxAgeDays = 90): string[] {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  const removed: string[] = []
  for (const sub of PRUNED_DIRS) {
    const dir = join(kanonHome, sub)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs >= cutoff) continue
        rmSync(full, { force: true })
        removed.push(full)
      } catch {
        // A file that cannot be stat'd or removed is left alone.
      }
    }
  }
  return removed
}
```

- [ ] **Step 4: Apply the size guard in the rules discoverer**

In `src/discover/rules.ts`, add the import:

```ts
import { tooLarge } from '../limits'
```

and inside `visit`, immediately after `if (!name.endsWith('.md')) continue`, add:

```ts
      if (tooLarge(full)) continue
```

- [ ] **Step 5: Prune on every CLI run**

In `src/cli.ts`, add the import:

```ts
import { prune } from './limits'
```

and immediately after the `const cwd = arg('cwd') ?? process.cwd()` line, add:

```ts
try {
  prune(kanonHome(), Date.now())
} catch {
  // Pruning is housekeeping. It must never stop a report being produced.
}
```

- [ ] **Step 6: Run the whole suite**

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/limits.ts src/discover/rules.ts src/cli.ts test/limits.test.ts
git commit -m "feat: skip oversized instruction files and prune old records"
```

---

## Verification

After Task 9, install the plugin and run a real session in a repository with a
vendored `CLAUDE.md`. Read a file under `vendor/` or `node_modules/` to trigger
the lazy load, then run `/kanon`.

The report is correct when it shows the vendored file under `LOADED` marked
`FOREIGN`, shows your own files as `project` and `user`, and either lists no
model disagreement or names one honestly.
