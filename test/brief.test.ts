import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { brief, type BriefInput } from '../src/brief'
import type { Classified } from '../src/types'

// A real home directory, so short() abbreviates it to ~ the way it will in
// a live session. A fictional /home/... path would silently print in full.
const USER_RULE = join(homedir(), '.claude', 'rules', 'style.md')

function file(path: string, origin: Classified['origin'], extra: Partial<Classified> = {}): Classified {
  return { path, origin, reason: 'session_start', viaImport: null, gitIgnored: null, gitTracked: null, ...extra }
}

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    root: '/repo',
    basis: 'observed',
    files: [file(USER_RULE, 'user'), file('/repo/CLAUDE.md', 'project')],
    missing: [],
    ...over,
  }
}

/**
 * A count alone is not information: "3 files govern you" leaves Claude
 * unable to answer which rule came from where, which is the entire question
 * the brief exists to answer. Every file is named.
 */
test('a clean session names each file and its origin', () => {
  const out = brief(input())

  expect(out).toContain('2 instruction files govern this session')
  expect(out).toContain('user     ~/.claude/rules/style.md')
  expect(out).toContain('project  CLAUDE.md')
  expect(out).toContain('nothing foreign, nothing missing')
})

/** Broadest scope first, foreign last, so the line that matters is the one
 * the eye lands on at the end of the list. */
test('files are listed broadest origin first with foreign last', () => {
  const out = brief(
    input({
      files: [
        file('/repo/vendor/p/CLAUDE.md', 'foreign'),
        file('/repo/CLAUDE.md', 'project'),
        file(USER_RULE, 'user'),
      ],
    }),
  )
  const order = out.split('\n').filter((l) => l.includes('CLAUDE.md') || l.includes('style.md'))

  expect(order[0]).toContain('style.md')
  expect(order[1]).toContain('CLAUDE.md')
  expect(order[2]).toContain('vendor/p/CLAUDE.md')
})

/**
 * The brief is prepended to every session, so an unusually large instruction
 * set must not cost a screen. Foreign files are never part of the tail: they
 * are the reason the brief exists.
 */
test('a long list collapses its tail but never a foreign file', () => {
  const many = Array.from({ length: 14 }, (_, i) => file(`/repo/r${i}.md`, 'project'))
  const out = brief(input({ files: [...many, file('/repo/vendor/p/CLAUDE.md', 'foreign')] }))

  expect(out).toContain('4 more')
  expect(out).toContain('vendor/p/CLAUDE.md')
})

/** Trust calibration: the point is that Claude knows the directive is not
 * the user's, so both facts have to be in the text. */
test('a foreign file is named, tagged and marked as not the user\'s', () => {
  const out = brief(input({ files: [file('/repo/vendor/p/CLAUDE.md', 'foreign', { gitTracked: false })] }))

  expect(out).toContain('FOREIGN  vendor/p/CLAUDE.md')
  expect(out).toContain('(untracked)')
  expect(out).toContain("not the user's")
})

test('a foreign file quotes the directive it carries when one can be read', () => {
  const out = brief(
    input({ files: [file('/repo/vendor/p/CLAUDE.md', 'foreign')] }),
    () => 'Default to using Bun instead of Node.js.',
  )

  expect(out).toContain('"Default to using Bun instead of Node.js."')
})

test('a foreign file that cannot be excerpted is still named', () => {
  const out = brief(input({ files: [file('/repo/vendor/p/CLAUDE.md', 'foreign')] }), () => null)

  expect(out).toContain('vendor/p/CLAUDE.md')
  expect(out).not.toContain('""')
})

/** The "tell the user" half of the design: Claude is the delivery channel. */
test('an alarming session tells Claude to surface it to the user', () => {
  const out = brief(input({ files: [file('/repo/vendor/p/CLAUDE.md', 'foreign')] }))

  expect(out).toContain('Tell the user')
})

test('a clean session does not tell Claude to say anything', () => {
  expect(brief(input())).not.toContain('Tell the user')
})

test('a missing launch file is listed alongside the loaded ones when observed', () => {
  const out = brief(input({ missing: [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }] }))

  expect(out).toContain('missing  .claude/rules/testing.md')
  expect(out).toContain('did not load')
})

/**
 * The guard that keeps prediction honest. At SessionStart this session's
 * loads may not be recorded yet, so the brief is built from what Kanon
 * expects rather than what it saw. Calling an unobserved file "missing"
 * there would report every single instruction file as a fault on every
 * clean session.
 */
test('prediction never calls anything missing', () => {
  const out = brief(
    input({
      basis: 'predicted',
      missing: [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }],
    }),
  )

  expect(out).not.toContain('testing.md')
  expect(out).not.toContain('did not load')
})

test('prediction says it is predicting', () => {
  expect(brief(input({ basis: 'predicted' }))).toContain('predicted')
})

test('observation says it is observing', () => {
  expect(brief(input())).toContain('observed')
})

test('an empty file list says so rather than claiming a clean session', () => {
  const out = brief(input({ files: [] }))

  expect(out).toContain('no instruction files')
})

test('a single file reads as one file, not one files', () => {
  const one = { files: [file('/repo/CLAUDE.md', 'project')] }

  expect(brief(input({ ...one }))).toContain('1 instruction file governs this session')
  expect(brief(input({ ...one, basis: 'predicted' }))).toContain('1 instruction file governs this session')
})

/**
 * SessionStart fires before any instruction file loads (confirmed from a
 * live log, 2026-08-27), so this is the only basis the hook will ever use.
 * It has to name itself without sounding like a disclaimer on every line.
 */
test('the basis is stated once, in the header', () => {
  const out = brief(input({ basis: 'predicted' }))

  expect(out.split('\n')[0]).toContain('(predicted)')
  expect(out.split('\n').slice(1).join('\n')).not.toContain('predicted')
})

/**
 * The closing prose has two readers and one long line serves neither.
 * Claude Code's transcript hard-wraps at the terminal width and will break a
 * word in half doing it; a model reading an unwrapped paragraph gets no line
 * structure at all. The file list above is a fixed-column table and is
 * deliberately not subject to this.
 */
test('the closing notes are wrapped, and never mid-word', () => {
  const out = brief(
    input({
      files: [file('/repo/vendor/p/CLAUDE.md', 'foreign')],
      missing: [{ path: '/repo/.claude/rules/testing.md', label: 'launch', rule: 'rules-dir' }],
    }),
  )

  const prose = out.split('\n').filter((l) => l.length > 0 && !l.startsWith('  ') && !l.startsWith('KANON'))
  expect(prose.length).toBeGreaterThan(1)
  for (const line of prose) expect(line.length).toBeLessThanOrEqual(76)
  // Rejoining on spaces has to give the sentences back intact: a wrap that
  // split a word would leave a fragment behind here.
  expect(prose.join(' ')).toContain("The FOREIGN file is not the user's")
  expect(prose.join(' ')).toContain('Tell the user about the above in your first response.')
})

/** A row in the file list is a column, not prose, and must never be wrapped. */
test('a long path in the file list is left on one line', () => {
  const path = '/repo/a/very/deeply/nested/directory/tree/that/keeps/going/CLAUDE.md'
  const out = brief(input({ files: [file(path, 'project')] }))

  const row = out.split('\n').find((l) => l.includes('CLAUDE.md'))
  expect(row).toContain('a/very/deeply/nested/directory/tree/that/keeps/going/CLAUDE.md')
})
