import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashFile } from '../src/drift'
import type { Probe } from '../src/stale'
import { acknowledge, isAcknowledged, namedDigests, steer, type SteeringInput } from '../src/steering'
import { EMPTY_FACTS } from '../src/transcript'
import type { Classified } from '../src/types'
import { tmp } from './tmp'

/** A probe that answers from disk for existence, finds every name in code, and tracks and ignores nothing. */
const diskProbe: Probe = {
  exists: (p) => existsSync(p),
  occursInCode: (names) => new Set(names),
  scripts: () => null,
  changedSince: () => [],
  trackedPaths: () => [],
  ignored: () => new Set(),
}

const cls = (path: string, origin: Classified['origin'] = 'project'): Classified => ({
  path,
  origin,
  reason: 'session_start',
  viaImport: null,
  gitIgnored: null,
  gitTracked: null,
})

function setup() {
  const base = tmp('kanon-steer-')
  const root = join(base, 'repo')
  const home = join(base, 'home')
  const memoryDir = join(home, '.claude', 'projects', 'p', 'memory')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(root, 'CLAUDE.md'), 'Run `bun test`.\n')
  writeFileSync(join(root, 'src', 'x.ts'), 'export const x = 1\n')
  writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Notes](notes.md)\n')
  writeFileSync(join(memoryDir, 'a-first.md'), 'The entry is `src/x.ts`.\n')
  writeFileSync(join(memoryDir, 'notes.md'), 'See `src/gone.ts` for the parser.\n')
  writeFileSync(join(memoryDir, 'not-markdown.txt'), 'ignored\n')
  const input = (over: Partial<SteeringInput> = {}): SteeringInput => ({
    root,
    home,
    instructions: [cls(join(root, 'CLAUDE.md'))],
    memoryDir,
    facts: EMPTY_FACTS,
    probe: diskProbe,
    written: () => new Date('2026-01-01'),
    read: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    acks: [],
    ...over,
  })
  return { root, home, memoryDir, input }
}

describe('steer', () => {
  test('lists instructions first, then memory files with MEMORY.md first', () => {
    const { root, memoryDir, input } = setup()
    const items = steer(input())
    expect(items.map((i) => i.path)).toEqual([
      join(root, 'CLAUDE.md'),
      join(memoryDir, 'MEMORY.md'),
      join(memoryDir, 'a-first.md'),
      join(memoryDir, 'notes.md'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['instruction', 'memory', 'memory', 'memory'])
    expect(items.slice(1).every((i) => i.origin === 'user')).toBe(true)
    expect(items[0].digest).toBe(hashFile(join(root, 'CLAUDE.md')))
  })

  test('a memory already among the instructions appears once, as a memory', () => {
    const { memoryDir, input } = setup()
    const mem = join(memoryDir, 'MEMORY.md')
    const base = input()
    const items = steer({ ...base, instructions: [...base.instructions, cls(mem, 'user')] })
    expect(items.filter((i) => i.path === mem)).toHaveLength(1)
    expect(items.find((i) => i.path === mem)?.kind).toBe('memory')
  })

  test('a MEMORY.md the transcript saw loading is listed even without a memory dir', () => {
    const { memoryDir, input } = setup()
    const mem = join(memoryDir, 'MEMORY.md')
    const facts = { ...EMPTY_FACTS, instructions: [{ path: mem, type: 'AutoMem' }] }
    const items = steer(input({ memoryDir: null, facts }))
    expect(items.map((i) => [i.path, i.kind, i.origin])).toContainEqual([mem, 'memory', 'user'])
  })

  test('a memory naming a gone path carries that verdict', () => {
    const { memoryDir, input } = setup()
    const items = steer(input())
    expect(items.find((i) => i.path === join(memoryDir, 'notes.md'))?.verdict).toEqual({
      level: 'gone',
      evidence: 'names `src/gone.ts`, which no longer exists',
    })
    expect(items.find((i) => i.path === join(memoryDir, 'a-first.md'))?.verdict).toBeNull()
  })

  test('with no memory dir and no transcript the instructions still come back', () => {
    const { root, input } = setup()
    const items = steer(input({ memoryDir: null, facts: EMPTY_FACTS }))
    expect(items.map((i) => i.path)).toEqual([join(root, 'CLAUDE.md')])
  })

  test('a memory dir that does not exist is no memory files, not a throw', () => {
    const { root, input } = setup()
    const items = steer(input({ memoryDir: join(root, 'no-such-dir') }))
    expect(items.map((i) => i.path)).toEqual([join(root, 'CLAUDE.md')])
  })

  test('an unreadable item gets no digest and no verdict, and never throws', () => {
    const { root, input } = setup()
    const items = steer(
      input({
        instructions: [cls(join(root, 'missing.md'))],
        memoryDir: null,
        read: () => null,
        written: () => {
          throw new Error('stat failed')
        },
      }),
    )
    expect(items).toEqual([
      { path: join(root, 'missing.md'), kind: 'instruction', origin: 'project', digest: null, verdict: null, acknowledged: false },
    ])
  })

  test('acknowledged follows the stored ack until the item or a named file changes', () => {
    const { root, home, memoryDir, input } = setup()
    const path = join(memoryDir, 'a-first.md')
    const first = steer(input()).find((i) => i.path === path)!
    expect(first.acknowledged).toBe(false)
    const text = 'The entry is `src/x.ts`.\n'
    const ack = acknowledge(first, namedDigests(text, path, root, home), new Date('2026-02-01T00:00:00Z'))
    expect(ack).toEqual({
      path,
      digest: first.digest,
      named: { 'src/x.ts': hashFile(join(root, 'src', 'x.ts')) },
      t: '2026-02-01T00:00:00.000Z',
    })
    expect(steer(input({ acks: [ack] })).find((i) => i.path === path)?.acknowledged).toBe(true)

    writeFileSync(join(root, 'src', 'x.ts'), 'export const x = 2\n')
    expect(steer(input({ acks: [ack] })).find((i) => i.path === path)?.acknowledged).toBe(false)
  })

  test('an edited item clears its acknowledgement', () => {
    const { root, home, memoryDir, input } = setup()
    const path = join(memoryDir, 'a-first.md')
    const first = steer(input()).find((i) => i.path === path)!
    const ack = acknowledge(first, namedDigests('The entry is `src/x.ts`.\n', path, root, home), new Date())
    writeFileSync(path, 'The entry is `src/x.ts`, still.\n')
    expect(steer(input({ acks: [ack] })).find((i) => i.path === path)?.acknowledged).toBe(false)
  })
})

describe('a malformed ack never costs a verdict', () => {
  for (const [label, acks] of [
    ['a null ack', [null]],
    ['an ack missing named', [{ path: 'MATCH', digest: 'MATCH', t: 'x' }]],
  ] as const) {
    test(label, () => {
      const { memoryDir, input } = setup()
      const path = join(memoryDir, 'notes.md')
      const real = acks.map((a) => (a ? { ...a, path, digest: hashFile(path) } : a)) as unknown as SteeringInput['acks']
      const row = steer(input({ acks: real })).find((i) => i.path === path)
      expect(row?.verdict?.level).toBe('gone')
      expect(row?.acknowledged).toBe(false)
    })
  }
})

describe('isAcknowledged', () => {
  const item = {
    path: '/home/user/proj/CLAUDE.md',
    kind: 'instruction' as const,
    origin: 'project' as const,
    digest: 'd1',
    verdict: null,
    acknowledged: false,
  }
  const ack = { path: item.path, digest: 'd1', named: { 'src/a.ts': 'h1' }, t: '2026-02-01T00:00:00.000Z' }

  test('true only while the item digest and every named digest match', () => {
    expect(isAcknowledged(item, [ack], { 'src/a.ts': 'h1' })).toBe(true)
    expect(isAcknowledged({ ...item, digest: 'd2' }, [ack], { 'src/a.ts': 'h1' })).toBe(false)
    expect(isAcknowledged(item, [ack], { 'src/a.ts': 'h2' })).toBe(false)
  })

  test('a named file that appeared or vanished clears it', () => {
    expect(isAcknowledged(item, [ack], {})).toBe(false)
    expect(isAcknowledged(item, [ack], { 'src/a.ts': 'h1', 'src/b.ts': 'h3' })).toBe(false)
  })

  test('another path, or an unreadable item, is never acknowledged', () => {
    expect(isAcknowledged({ ...item, path: '/home/user/proj/other.md' }, [ack], { 'src/a.ts': 'h1' })).toBe(false)
    expect(isAcknowledged({ ...item, digest: null }, [{ ...ack, digest: null }], { 'src/a.ts': 'h1' })).toBe(false)
  })
})

describe('namedDigests', () => {
  test('hashes each named path that exists, resolved like the judge, keyed by the name', () => {
    const base = tmp('kanon-named-')
    const root = join(base, 'repo')
    const home = join(base, 'home')
    const dir = join(root, 'docs')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(home, '.config'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'a\n')
    writeFileSync(join(dir, 'local.md'), 'l\n')
    writeFileSync(join(home, '.config', 'tool.json'), '{}\n')
    writeFileSync(join(base, 'abs.txt'), 'abs\n')
    const text = [
      '`src/a.ts`, `local.md`, `~/.config/tool.json`,',
      `\`${join(base, 'abs.txt')}\`, \`src/missing.ts\`, \`@types/node\`.`,
    ].join('\n')
    expect(namedDigests(text, join(dir, 'item.md'), root, home)).toEqual({
      'src/a.ts': hashFile(join(root, 'src', 'a.ts')),
      'local.md': hashFile(join(dir, 'local.md')),
      '~/.config/tool.json': hashFile(join(home, '.config', 'tool.json')),
      [join(base, 'abs.txt')]: hashFile(join(base, 'abs.txt')),
    })
  })
})

describe('steer time bound and batching', () => {
  /** Past the deadline nothing more is judged, but every item is still listed, so the cache still has rows. */
  test('a deadline already passed leaves every verdict null and still returns the model', () => {
    const { root, memoryDir, input } = setup()
    const items = steer(input({ deadline: 0 }))
    expect(items.map((i) => i.path)).toEqual([
      join(root, 'CLAUDE.md'),
      join(memoryDir, 'MEMORY.md'),
      join(memoryDir, 'a-first.md'),
      join(memoryDir, 'notes.md'),
    ])
    expect(items.every((i) => i.verdict === null)).toBe(true)
    expect(items[0].digest).toBe(hashFile(join(root, 'CLAUDE.md')))
  })

  /** One grep per session start, however many items name things, is what keeps the hook inside its timeout. */
  test('every item\'s code lookups go to the probe in one occursInCode call', () => {
    const { memoryDir, input } = setup()
    writeFileSync(join(memoryDir, 'b.md'), 'Call `alphaFn` first.\n')
    writeFileSync(join(memoryDir, 'c.md'), 'Then `betaFn`, and pass `--gamma`.\n')
    const calls: string[][] = []
    const probe: Probe = {
      ...diskProbe,
      occursInCode: (names) => {
        calls.push([...names].sort())
        return new Set(names.filter((n) => n !== 'betaFn'))
      },
    }
    const items = steer(input({ probe }))
    expect(calls).toEqual([['--gamma', 'alphaFn', 'betaFn']])
    expect(items.find((i) => i.path.endsWith('b.md'))?.verdict).toBeNull()
    expect(items.find((i) => i.path.endsWith('c.md'))?.verdict).toEqual({ level: 'may-be-stale', evidence: 'names `betaFn`, which no longer occurs in the code' })
  })
})
