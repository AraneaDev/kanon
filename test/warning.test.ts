import { expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp'
import type { Steered } from '../src/steering'
import { warning } from '../src/warning'

const CLI = '/opt/kanon/src/cli.ts'
const ROOT = '/srv/repo'

const item = (path: string, verdict: Steered['verdict']): Steered => ({
  path,
  kind: 'memory',
  origin: 'user',
  digest: 'abc',
  verdict,
  acknowledged: false,
})

test('a gone item asks before reliance and prints the ack command with the path the row shows', () => {
  const s = item('/srv/memory/release-flow.md', { level: 'gone', evidence: 'names `scripts/release.sh`, which no longer exists' })
  expect(warning(s, ROOT, CLI)).toBe(
    'KANON  /srv/memory/release-flow.md names `scripts/release.sh`, which no longer exists. ' +
      'Before relying on it, ask the user whether it still holds. ' +
      `If it does, run: bun '${CLI}' ack --cwd '${ROOT}' '/srv/memory/release-flow.md'`,
  )
})

test('a file under the root is named root-relative, in the text and in the ack command alike', () => {
  const s = item(`${ROOT}/CLAUDE.md`, { level: 'gone', evidence: 'names `docs/x.md`, which no longer exists' })
  const text = warning(s, ROOT, CLI)
  expect(text.startsWith('KANON  CLAUDE.md names')).toBe(true)
  expect(text.endsWith(`ack --cwd '${ROOT}' 'CLAUDE.md'`)).toBe(true)
})

test('a may-be-stale item is a one-line note and never an ask', () => {
  const s = item('/srv/memory/notes.md', { level: 'may-be-stale', evidence: '`src/x.ts` changed after this was written' })
  const text = warning(s, ROOT, CLI)
  expect(text).toBe('KANON  note: /srv/memory/notes.md may be stale: `src/x.ts` changed after this was written.')
  expect(text).not.toContain('ack')
})

test('an item with no verdict has nothing to say', () => {
  expect(warning(item('/srv/memory/notes.md', null), ROOT, CLI)).toBe('')
})

test('evidence quoting a name from a file Kanon did not write cannot carry terminal escapes', () => {
  const s = item('/srv/memory/x.md', { level: 'may-be-stale', evidence: 'names `a\u001b[31mb`, which no longer occurs in the code' })
  expect(warning(s, ROOT, CLI)).not.toContain('\u001b')
})

/**
 * A cloned repository chooses its rule filenames, and Claude is told to run
 * this command as printed. Run through a shell, every argument must arrive
 * literally: no command substitution, no backtick, no broken quote.
 */
test('the ack command passes a hostile path literally through sh', () => {
  const dir = tmp('kanon-ack-quote-')
  const marker = join(dir, 'pwned')
  const argv = join(dir, 'argv')
  writeFileSync(join(dir, 'bun'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argv}'\n`)
  chmodSync(join(dir, 'bun'), 0o755)
  const root = `${dir}/it's repo`
  const name = `rules/$(touch ${marker})\`touch ${marker}\`it's\u0007.md`
  const s = item(`${root}/${name}`, { level: 'gone', evidence: 'names `x.sh`, which no longer exists' })
  const text = warning(s, root, `${dir}/cli's.ts`)
  const command = text.slice(text.indexOf('run: ') + 'run: '.length)
  const p = Bun.spawnSync(['sh', '-c', command], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
  expect(p.exitCode).toBe(0)
  expect(existsSync(marker)).toBe(false)
  expect(readFileSync(argv, 'utf8').split('\n').slice(0, -1)).toEqual([`${dir}/cli's.ts`, 'ack', '--cwd', root, name.replace('\u0007', '')])
})
