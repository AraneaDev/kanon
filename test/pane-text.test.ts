// Assertions ported from Knossos-MCP hooks/lib specs (cards, rows, marks, layout) at a4412478, adapted to bun:test.
import { describe, expect, it } from 'bun:test'
import { cardInner, cardRows, figures, gridColumns, moreRows, noteOf, topRow, windowOf } from '../hooks/lib/cards'
import type { Section } from '../hooks/lib/cards'
import { CARD_GLYPH, legend, MARK, mark } from '../hooks/lib/marks'
import { ACCENT, FAINT, HEADING, SECONDARY, STATUS_COLOURS, TITLE } from '../hooks/lib/palette'
import { button, clip, rowWidth, spread, walkedRow } from '../hooks/lib/rows'
import { tierOf } from '../hooks/lib/tiers'
import { cells, fit, fitStart, pathParts, pathText } from '../hooks/lib/text'
import type { Row } from '../hooks/lib/types'

const rawText = (row: Row): string => row.segments.map(s => s.text).join('')
const line = (key: string, text: string): Row => ({ key, segments: [{ text }] })
const PATH = 'src/Query/Drift/GitDriftOracle.php'

describe('fit and fitStart', () => {
  it('cuts to the width with an ellipsis, or leaves the text whole', () => {
    expect(fit('StableId', 8)).toBe('StableId')
    expect(fit('StableId', 5)).toBe('Stab…')
    expect(fit('StableId', 0)).toBe('')
  })
  it('cuts from the front, so a path keeps its file name', () => {
    expect(fitStart('workers/typescript/src/scanner.js', 12)).toBe('…/scanner.js')
    expect(fitStart('short.js', 12)).toBe('short.js')
  })
})

describe('display width', () => {
  it('counts wide characters as two cells, a combining mark as none', () => {
    expect(cells('漢字')).toBe(4)
    expect(cells('a😀')).toBe(3)
    expect(cells('é')).toBe(1)
  })
  it('never draws a wide path wider than the width, and never splits a grapheme', () => {
    const path = 'src/漢字/データ/ファイル👩‍💻.ts'
    for (let width = 1; width <= 40; width++) {
      const { dir, base } = pathParts(path, width)
      const drawn = dir + base
      expect(cells(drawn)).toBeLessThanOrEqual(width)
      expect(drawn.includes('‍') ? drawn.includes('👩‍💻') : true).toBe(true)
    }
  })
})

describe('a path in two tones', () => {
  it('keeps the whole path when it fits, split at its last slash', () => {
    expect(pathParts(PATH, 60)).toEqual({ dir: 'src/Query/Drift/', base: 'GitDriftOracle.php' })
    expect(pathParts('README.md', 20)).toEqual({ dir: '', base: 'README.md' })
  })
  it('cuts the middle of the directory, by whole folders first, never the file name', () => {
    expect(pathParts(PATH, 30)).toEqual({ dir: 'src/…/Drift/', base: 'GitDriftOracle.php' })
    expect(pathParts(PATH, 27)).toEqual({ dir: '…/Drift/', base: 'GitDriftOracle.php' })
    expect(pathParts(PATH, 22)).toEqual({ dir: 'sr…/', base: 'GitDriftOracle.php' })
    expect(pathParts(PATH, 20)).toEqual({ dir: '…/', base: 'GitDriftOracle.php' })
    // Only a file name wider than the width is cut, at its end.
    expect(pathParts(PATH, 12)).toEqual({ dir: '', base: 'GitDriftOra…' })
  })
  it('never draws wider than the width it has, and keeps the file name while it fits with a cut', () => {
    for (let width = 1; width <= 40; width++) {
      const { dir, base } = pathParts(PATH, width)
      expect(cells(dir) + cells(base), `${width}`).toBeLessThanOrEqual(width)
      if (width >= cells('GitDriftOracle.php') + 2) expect(base).toBe('GitDriftOracle.php')
    }
  })
  it('gives pathText as the two parts joined', () => {
    expect(pathText(PATH, 30)).toBe('src/…/Drift/GitDriftOracle.php')
  })
})

describe('tiers', () => {
  it('switch at 80 and past 130', () => {
    expect([40, 79, 80, 100, 130, 131, 200].map(tierOf)).toEqual(['narrow', 'narrow', 'medium', 'medium', 'medium', 'wide', 'wide'])
  })
  it('frame medium and wide cards, and leave a narrow card its every column', () => {
    expect(cardInner(60, 'narrow')).toBe(60)
    expect(cardInner(100, 'medium')).toBe(96)
    expect(cardInner(140, 'wide')).toBe(136)
  })
  it('splits the wide grid into two columns two apart, the list left at 55%', () => {
    const [l, r] = gridColumns(140, 0.55)
    expect(l + 2 + r).toBe(140)
    expect(l).toBe(Math.floor(138 * 0.55))
    const [a, b] = gridColumns(100)
    expect([a, b]).toEqual([49, 49])
  })
})

describe('cards', () => {
  const section: Section = { key: 's', title: 'Memory', subtitle: 'user and project', note: [{ text: '≈ 1 stale', dim: true }], body: [line('s-0', 'StableId'), line('s-1', '›  A long row')] }

  for (const columns of [40, 60, 80, 100, 130, 140, 200]) {
    it(`exactly fill ${columns} columns with their edges, framed or not by the tier`, () => {
      const tier = tierOf(columns)
      const rows = cardRows(section, columns, tier)
      expect(rowWidth(rows[0]!)).toBe(columns)
      expect(rawText(rows[1]!).trim()).toBe('')
      if (tier === 'narrow') {
        expect(rawText(rows[0]!)).toMatch(/^── ◇ Memory/)
        expect(rawText(rows[2]!)).toBe('StableId')
      } else {
        expect(rawText(rows[0]!)).toMatch(/^── ◇ Memory .*──$/)
        for (const r of rows.slice(1)) expect(rowWidth(r), r.key).toBe(columns)
        for (const r of rows.slice(2)) expect(rawText(r)).toMatch(/^ {2}\S/)
      }
      expect(rows).toHaveLength(4)
    })
  }

  it('sets the note against the right corner, and gives way: subtitle, then the title is cut, then the note', () => {
    expect(rawText(topRow(section, 100))).toMatch(/^── ◇ Memory · user and project ─+ ≈ 1 stale ──$/)
    expect(rawText(topRow(section, 40))).toMatch(/^── ◇ Memory ─+ ≈ 1 stale ──$/)
    const long: Section = { ...section, title: 'Instruction files', subtitle: undefined }
    expect(rawText(topRow(long, 36))).toBe('── ◇ Instruction fil… ─ ≈ 1 stale ──')
    expect(rawText(topRow(long, 29))).toMatch(/^── ◇ Instruction files ─+$/)
    const tiny = topRow(section, 14)
    expect(rowWidth(tiny)).toBeLessThanOrEqual(14)
    expect(rawText(tiny)).toContain('Mem')
  })

  it('titles in bold, its glyph alone in the orange, with no box around the card', () => {
    const rows = cardRows(section, 60, 'medium')
    expect(rows[0]!.segments.find(s => s.text === 'Memory')).toMatchObject({ color: HEADING, bold: true })
    expect(rows[0]!.segments.find(s => s.text === `${CARD_GLYPH} `)).toMatchObject({ color: TITLE })
    expect(rows.map(rawText).some(t => /[│╭╮╰╯]/.test(t))).toBe(false)
  })

  it('cuts a body row too wide for the frame', () => {
    const rows = cardRows({ key: 'd', title: 'Rules', body: [line('d-0', 'y'.repeat(200))] }, 100, 'medium')
    expect(rowWidth(rows[2]!)).toBe(100)
  })

  it('collapses an empty card to one ruled line, its note saying how it stands, else its word', () => {
    for (const tier of ['narrow', 'medium', 'wide'] as const) {
      const noted = cardRows({ key: 'e', title: 'Rules', body: [], empty: 'none', note: [{ text: '✓ 0' }] }, 60, tier)
      expect(noted).toHaveLength(1)
      expect(rawText(noted[0]!)).toMatch(/^── ◇ Rules ─+ ✓ 0 ──$/)
      expect(rowWidth(noted[0]!)).toBe(60)
      const worded = cardRows({ key: 'e', title: 'Rules', body: [], empty: 'none' }, 60, tier)
      expect(rawText(worded[0]!)).toMatch(/^── ◇ Rules ─+ none ──$/)
    }
  })

  it('draws figures in a note at full contrast and the words around them dim', () => {
    expect(figures('3 files → 594 dependents · 1 test')).toEqual([
      { text: '3', color: 'text' },
      { text: ' files → ', dim: true },
      { text: '594', color: 'text' },
      { text: ' dependents · ', dim: true },
      { text: '1', color: 'text' },
      { text: ' test', dim: true },
    ])
    expect(figures('10+ boundaries · 31,796 deps').map(s => s.text)).toEqual(['10+', ' boundaries · ', '31,796', ' deps'])
    expect(figures('')).toEqual([])
    expect(noteOf('partial')).toEqual([{ text: 'partial', dim: true }])
  })
})

describe('the line under a cut list', () => {
  it('counts what is above and below, and is nothing when all shows', () => {
    expect(moreRows('m', { start: 0, end: 3 }, 10, 40)).toEqual([{ key: 'm', segments: [{ text: '   7 more ↓', dim: true }] }])
    expect(moreRows('m', { start: 2, end: 5 }, 10, 40)[0]!.segments[0]!.text).toBe('   2 above ↑ · 5 more ↓')
    expect(moreRows('m', { start: 0, end: 3 }, 3, 40)).toEqual([])
  })
  it('fits its width', () => {
    expect(rowWidth(moreRows('m', { start: 2, end: 5 }, 10, 10)[0]!)).toBeLessThanOrEqual(10)
  })
  it('windows a list around the marker', () => {
    expect(windowOf(10, 3, 0)).toEqual({ start: 0, end: 3 })
    expect(windowOf(10, 3, 5)).toEqual({ start: 3, end: 6 })
    expect(windowOf(10, 3, 9)).toEqual({ start: 7, end: 10 })
    expect(windowOf(2, 3, 1)).toEqual({ start: 0, end: 2 })
  })
})

describe('rows', () => {
  it('cuts the last text segment that crosses the edge, and drops a pressable one whole', () => {
    expect(clip([{ text: 'abc' }, { text: 'defgh' }, { text: 'ij' }], 6)).toEqual([{ text: 'abc' }, { text: 'de…' }])
    const press = button('o', 'open', 'o')
    expect(clip([{ text: 'abcd' }, press], 8)).toEqual([{ text: 'abcd' }])
  })
  it('puts the marker before a marked row, tinted to the edge', () => {
    const row = walkedRow('r', true, [{ text: 'x' }], 6)
    expect(rawText(row)).toBe('›x    ')
    expect(row.tint).toBeDefined()
    expect(rawText(walkedRow('r', false, [{ text: 'x' }], 6))).toBe(' x')
  })
  it('spreads left and right apart, the right dropped when both do not fit', () => {
    expect(rawText(spread('s', [{ text: 'ab' }], [{ text: 'cd' }], 8))).toBe('ab    cd')
    expect(rawText(spread('s', [{ text: 'ab' }], [{ text: 'cdefgh' }], 6))).toBe('ab')
  })
})

describe('the mark registry', () => {
  it('gives each meaning one glyph, and each glyph one meaning', () => {
    expect(Object.values(MARK).map(m => m.glyph)).toEqual(['▲', '≈', '!', '✓', '◦'])
    expect(new Set(Object.values(MARK).map(m => m.glyph)).size).toBe(Object.keys(MARK).length)
    expect({ gone: MARK.gone.glyph, stale: MARK.stale.glyph, foreign: MARK.foreign.glyph, acked: MARK.acked.glyph, none: MARK.none.glyph }).toEqual({ gone: '▲', stale: '≈', foreign: '!', acked: '✓', none: '◦' })
  })
  it('never uses the card glyph as a row mark', () => {
    expect(Object.values(MARK).some(m => m.glyph === CARD_GLYPH)).toBe(false)
  })
  it('colours a mark by its tone, as a theme key, and never by colour alone', () => {
    expect(mark(MARK.gone)).toEqual({ text: '▲', color: STATUS_COLOURS.alert })
    expect(mark(MARK.stale, ' ')).toEqual({ text: '≈ ', color: STATUS_COLOURS.warn })
    expect(mark(MARK.foreign)).toEqual({ text: '!', color: STATUS_COLOURS.alert })
    expect(mark(MARK.acked)).toEqual({ text: '✓', color: STATUS_COLOURS.ok })
    expect(mark(MARK.none)).toEqual({ text: '◦', dim: true })
    for (const m of Object.values(MARK)) expect(mark(m).text.trim(), m.meaning).toBe(m.glyph)
  })
  it('uses theme keys only, never a hex value', () => {
    for (const key of [ACCENT, FAINT, HEADING, SECONDARY, TITLE, ...Object.values(STATUS_COLOURS)]) expect(key).not.toMatch(/^#/)
  })
  it('builds a legend of the marks shown, in the order given, leaving out zero counts', () => {
    expect(legend([[MARK.stale, 1], [MARK.foreign, 2]])).toBe('≈ 1 stale · ! 2 foreign')
    expect(legend([[MARK.stale, 0], [MARK.acked, 3]])).toBe('✓ 3 acknowledged')
    expect(legend([[MARK.gone, 0]])).toBe('')
    expect(legend([[MARK.none, '']])).toBe('◦ quiet')
    expect(legend([[MARK.gone, 1234]])).toBe('▲ 1,234 gone')
  })
})
