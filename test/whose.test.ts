import { expect, test } from 'bun:test'
import { matches, renderWhose } from '../src/whose'
import type { Classified } from '../src/types'

function match(path: string, origin: Classified['origin'], line: number, text: string) {
  return { path, origin, line, text }
}

function file(path: string, origin: Classified['origin'] = 'user'): Classified {
  return { path, origin, reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null }
}

/** A reader standing in for the filesystem, so these tests need no temp dir. */
function reader(contents: Record<string, string>) {
  return (path: string) => contents[path] ?? null
}

test('finds a phrase and reports the file, its origin and the line', () => {
  const got = matches([file('/rules/style.md')], 'em dashes', reader({ '/rules/style.md': '# Style\n\nNever use em dashes here.\n' }))
  expect(got).toHaveLength(1)
  expect(got[0]?.path).toBe('/rules/style.md')
  expect(got[0]?.origin).toBe('user')
  expect(got[0]?.line).toBe(3)
  expect(got[0]?.text).toBe('Never use em dashes here.')
})

test('matching ignores case', () => {
  const got = matches([file('/r.md')], 'NEVER USE', reader({ '/r.md': 'never use em dashes\n' }))
  expect(got).toHaveLength(1)
})

/**
 * The reason this is not a grep. Instruction files are hard-wrapped, so a
 * phrase a reader remembers as one sentence is often split across a line
 * break. Searching line by line would miss exactly the phrases someone would
 * think to type.
 */
test('finds a phrase that straddles a line break', () => {
  const got = matches(
    [file('/r.md')],
    'never use em dashes',
    reader({ '/r.md': 'Some preamble.\n\nA rule: never use\nem dashes in prose.\n' }),
  )
  expect(got).toHaveLength(1)
  expect(got[0]?.line).toBe(3)
})

test('reports the line where the match begins, not where it ends', () => {
  const got = matches([file('/r.md')], 'alpha beta', reader({ '/r.md': 'x\nalpha\nbeta\n' }))
  expect(got[0]?.line).toBe(2)
})

test('a phrase in several files yields a match per file, in the order given', () => {
  const got = matches(
    [file('/a.md', 'user'), file('/b.md', 'project')],
    'shared',
    reader({ '/a.md': 'shared\n', '/b.md': 'also shared\n' }),
  )
  expect(got.map((m) => m.path)).toEqual(['/a.md', '/b.md'])
})

test('no match yields an empty list rather than a guess', () => {
  expect(matches([file('/r.md')], 'absent', reader({ '/r.md': 'something else\n' }))).toEqual([])
})

/**
 * A file that cannot be read is not a match and must not throw. The reader
 * returns null for anything oversized or unreadable, matching how the rest
 * of the codebase treats a file it cannot open.
 */
test('an unreadable file is skipped, not fatal', () => {
  expect(matches([file('/gone.md')], 'anything', () => null)).toEqual([])
})

test('an empty phrase matches nothing, rather than every file', () => {
  expect(matches([file('/r.md')], '   ', reader({ '/r.md': 'text\n' }))).toEqual([])
})

test('renders each match with its origin, path and line', () => {
  const out = renderWhose('em dashes', [match('/repo/CLAUDE.md', 'project', 24, 'Never use em dashes.')], 'observed', '/repo', 5)
  expect(out).toContain('WHOSE  "em dashes"')
  expect(out).toContain('observed')
  expect(out).toContain('  project    CLAUDE.md                            line 24')
  expect(out).toContain('"Never use em dashes."')
})

/**
 * The informative half. If the phrase is in none of the governing files,
 * either it reached the session from a surface Kanon cannot see yet, or it
 * was never in an instruction file at all. Saying how many files were
 * searched is what makes that answer trustworthy.
 */
test('no match says so, names the count searched, and points at the blind spot', () => {
  const out = renderWhose('npm publish', [], 'observed', '/repo', 6)
  expect(out).toContain('no file governing this session contains that phrase')
  expect(out).toContain('6 files searched')
  expect(out).toContain('skill')
  expect(out).not.toContain('line ')
})

test('a predicted basis is labelled as such', () => {
  expect(renderWhose('x', [], 'predicted', '/repo', 2)).toContain('predicted')
})

test('one file searched reads as singular', () => {
  expect(renderWhose('x', [], 'observed', '/repo', 1)).toContain('1 file searched')
})
