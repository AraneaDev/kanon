import { expect, test } from 'bun:test'
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
      `If it does, run: bun "${CLI}" ack --cwd "${ROOT}" "/srv/memory/release-flow.md"`,
  )
})

test('a file under the root is named root-relative, in the text and in the ack command alike', () => {
  const s = item(`${ROOT}/CLAUDE.md`, { level: 'gone', evidence: 'names `docs/x.md`, which no longer exists' })
  const text = warning(s, ROOT, CLI)
  expect(text.startsWith('KANON  CLAUDE.md names')).toBe(true)
  expect(text.endsWith(`ack --cwd "${ROOT}" "CLAUDE.md"`)).toBe(true)
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
