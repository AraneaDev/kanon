import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_FACTS, readTranscript, reachesBefore } from '../src/transcript'

/**
 * The fixture is structurally real but its values are synthetic, because this
 * repository is public. Record shapes and field names follow live Claude Code
 * transcripts; paths, ids, commands and texts are invented. Its last line is
 * cut off mid-record, which is what a transcript being written looks like.
 */
const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures/transcript/session.jsonl'), 'utf8')
const facts = readTranscript(FIXTURE)
const lines = FIXTURE.split('\n').filter((l) => l.trim())

test('the AutoMem MEMORY.md is among the instruction loads, with its type', () => {
  expect(facts.instructions).toContainEqual({
    path: '/home/user/.claude/projects/-home-user-example/memory/MEMORY.md',
    type: 'AutoMem',
  })
  expect(facts.instructions).toContainEqual({ path: '/home/user/example/CLAUDE.md', type: 'Project' })
})

test('a repeated instructions attachment does not duplicate paths', () => {
  const again = readTranscript(`${FIXTURE}${lines.filter((l) => l.includes('"type":"instructions"')).join('\n')}\n`)
  expect(again.instructions).toEqual(facts.instructions)
  expect(new Set(facts.instructions.map((i) => i.path)).size).toBe(facts.instructions.length)
})

test('every element of a SessionStart injection becomes one Injection with its length', () => {
  const raw = JSON.parse(lines.find((l) => l.includes('"type":"hook_additional_context"'))!)
  const elements: string[] = raw.attachment.content
  expect(elements.length).toBeGreaterThanOrEqual(2)
  expect(facts.injections.map((i) => i.chars)).toEqual(elements.map((e) => e.length))
  expect(facts.injections.every((i) => i.hookName === 'SessionStart')).toBe(true)
})

test('an injection names the command whose stdout carried it, escaped or not', () => {
  const [first, second, third] = facts.injections
  expect(first?.command).toContain('run-hook.cmd')
  expect(second?.command).toContain('session-start.sh')
  expect(third?.command).toContain('example-plugin')
})

test('an injection whose text no hook stdout carries has a null command', () => {
  const orphan = JSON.stringify({
    type: 'attachment',
    attachment: { type: 'hook_additional_context', content: ['nobody printed this'], hookName: 'SessionStart' },
  })
  expect(readTranscript(orphan).injections).toEqual([{ hookName: 'SessionStart', chars: 19, command: null }])
})

test('a hook of another event never claims the injection', () => {
  const text = 'x'.repeat(250)
  const att = (a: object) => JSON.stringify({ type: 'attachment', attachment: a })
  const out = readTranscript(
    [
      att({ type: 'hook_success', hookName: 'PreToolUse:Read', command: 'wrong', stdout: text }),
      att({ type: 'hook_additional_context', content: [text], hookName: 'SessionStart' }),
    ].join('\n'),
  )
  expect(out.injections[0]?.command).toBeNull()
})

test('an invoked skill is read by name and path', () => {
  expect(facts.skills).toEqual([{ name: 'example-skill', path: 'userSettings:example-skill' }])
})

test('a compact_boundary yields its trigger and token counts', () => {
  expect(facts.compactions).toEqual([
    { t: '2026-10-21T13:08:19.681Z', trigger: 'auto', preTokens: 372150, postTokens: 23982 },
  ])
})

test('an assistant Read of a memory file is listed with its path', () => {
  expect(facts.reads).toEqual([
    {
      t: '2026-10-02T20:07:05.467Z',
      path: '/home/user/.claude/projects/-home-user-example/memory/notes.md',
    },
  ])
})

test('a truncated or non-JSON line is skipped, and the lines before it still count', () => {
  expect(lines.at(-1)).toBeDefined()
  expect(() => JSON.parse(lines.at(-1)!)).toThrow()
  expect(readTranscript(`not json\n{"type":\n${FIXTURE}`)).toEqual(facts)
})

test('an empty transcript is the empty facts', () => {
  expect(readTranscript('')).toEqual(EMPTY_FACTS)
})

test('renamed fields degrade to empty lists instead of throwing', () => {
  const odd = ['{"type":"attachment","attachment":{"type":"instructions","files":"nope"}}', '{"attachment":null}', '[]', 'null', '7']
  expect(readTranscript(odd.join('\n'))).toEqual(EMPTY_FACTS)
})

test('since keeps only records at or after it, and drops records with no timestamp', () => {
  const att = (path: string, timestamp?: string) =>
    JSON.stringify({ type: 'attachment', ...(timestamp ? { timestamp } : {}), attachment: { type: 'instructions', files: [{ path, type: 'Project' }] } })
  const text = [
    att('/home/user/example/earlier.md', '2026-10-24T00:00:00.400Z'),
    att('/home/user/example/undated.md'),
    att('/home/user/example/exact.md', '2026-10-24T00:10:00.000Z'),
    att('/home/user/example/later.md', '2026-10-24T00:10:00.400Z'),
  ].join('\n')
  const since = new Date('2026-10-24T00:10:00Z')
  expect(readTranscript(text, since).instructions.map((i) => i.path)).toEqual([
    '/home/user/example/exact.md',
    '/home/user/example/later.md',
  ])
  expect(readTranscript(text).instructions).toHaveLength(4)
})

test('reachesBefore asks whether the first record with a timestamp is older than since', () => {
  const since = new Date('2026-10-24T00:00:00.000Z')
  const rec = (timestamp?: string) => JSON.stringify(timestamp === undefined ? { type: 'x' } : { type: 'x', timestamp })
  // A fragment and a record with no timestamp are passed over to the first one that has one.
  expect(reachesBefore(['{"partial', rec(), rec('2026-10-23T23:59:59.000Z'), rec('2026-10-24T01:00:00.000Z')].join('\n'), since)).toBe(true)
  expect(reachesBefore([rec('2026-10-24T00:00:00.000Z'), rec('2026-10-23T00:00:00.000Z')].join('\n'), since)).toBe(false)
  expect(reachesBefore([rec(), 'not json'].join('\n'), since)).toBe(false)
  expect(reachesBefore('', since)).toBe(false)
})
