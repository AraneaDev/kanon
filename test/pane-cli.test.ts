import { describe, expect, test } from 'bun:test'
import { cliArgv, fenced, parseModel } from '../hooks/mod/cli'

// Synthetic values only: the repository is public.
const ROOT = '/home/user/.claude/plugins/kanon'
const CWD = '/home/user/project'

describe('cliArgv', () => {
  test('puts the runtime, the CLI and each argument in its own element', () => {
    expect(cliArgv('bun', ROOT, ['model', '--json', '--session', 's-1', '--cwd', CWD])).toEqual([
      'bun',
      `${ROOT}/src/cli.ts`,
      'model',
      '--json',
      '--session',
      's-1',
      '--cwd',
      CWD,
    ])
  })

  test('never splits or quotes a path a shell would expand', () => {
    const real = `/home/user/project/it's a $(x).md`
    const argv = cliArgv('/home/user/.bun/bin/bun', ROOT, ['ack', '--cwd', CWD, real])
    expect(argv).toHaveLength(6)
    expect(argv.at(-1)).toBe(real)
  })

  test('a plugin root with a trailing slash still names the CLI once', () => {
    expect(cliArgv('bun', `${ROOT}/`, ['report'])[1]).toBe(`${ROOT}/src/cli.ts`)
  })
})

describe('parseModel', () => {
  const model = { v: 1, root: CWD, basis: 'observed', ruleset: 'r1', instructions: [], memory: [], injected: [], skills: [], compactions: [] }

  test('a model line is ready', () => {
    const status = parseModel(`${JSON.stringify(model)}\n`)
    expect(status.kind).toBe('ready')
    if (status.kind === 'ready') expect(status.model.root).toBe(CWD)
  })

  test('an error object is the error, with its reason', () => {
    expect(parseModel(JSON.stringify({ v: 1, error: 'no such directory' }))).toEqual({ kind: 'error', reason: 'no such directory' })
  })

  test('stdout that is not JSON is an error that says so', () => {
    const status = parseModel('Segmentation fault\n')
    expect(status.kind).toBe('error')
  })

  test('nothing on stdout is an error', () => {
    expect(parseModel('').kind).toBe('error')
  })

  test('JSON that is not a model is an error, never a half-drawn pane', () => {
    expect(parseModel('[1,2]').kind).toBe('error')
    expect(parseModel(JSON.stringify({ v: 1, root: CWD })).kind).toBe('error')
    expect(parseModel('null').kind).toBe('error')
  })
})

describe('fenced', () => {
  test('wraps the report in a code fence', () => {
    expect(fenced('kanon report\n')).toBe('```\nkanon report\n```')
  })

  test('a report that holds a fence gets a longer one', () => {
    expect(fenced('a ``` b')).toBe('````\na ``` b\n````')
  })
})

describe('reasons from output Kanon did not shape', () => {
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001F\u007F-\u009F]/
  test('an error object and non-JSON output carry no control characters', () => {
    for (const out of [JSON.stringify({ v: 1, error: 'bad\x1b[31m\rthing' }), 'Seg\x1b[2Kfault\r\n']) {
      const status = parseModel(out)
      expect(status.kind).toBe('error')
      if (status.kind === 'error') expect(CONTROL.test(status.reason)).toBe(false)
    }
  })
})
