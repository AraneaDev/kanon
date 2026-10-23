import { describe, expect, test } from 'bun:test'
import { extractNames } from '../src/names'

const one = (md: string) => extractNames(md)

describe('extractNames', () => {
  test('a long flag in a code span is a flag', () => {
    expect(one('Pass `--commit-state` at the end.')).toEqual([{ kind: 'flag', text: '--commit-state' }])
  })

  test('run commands are scripts, bun test and bun install are not', () => {
    const got = one('`bun run release` `npm run build` `pnpm run x` `yarn y` `bun test` `bun install`')
    expect(got).toEqual([
      { kind: 'script', text: 'release' },
      { kind: 'script', text: 'build' },
      { kind: 'script', text: 'x' },
      { kind: 'script', text: 'y' },
    ])
  })

  test('code spans shaped like a path are paths', () => {
    expect(one('See `src/cli.ts`, `CLAUDE.md` and `~/.kanon/state/`.')).toEqual([
      { kind: 'path', text: 'src/cli.ts' },
      { kind: 'path', text: 'CLAUDE.md' },
      { kind: 'path', text: '~/.kanon/state/' },
    ])
  })

  test('a URL in a code span is skipped', () => {
    expect(one('`https://example.com/a/b.html` `http://example.com/x`')).toEqual([])
  })

  test('identifiers with a capital, an underscore or () are symbols', () => {
    expect(one('`buildReport` `MAX_FILE_BYTES` `prune()`')).toEqual([
      { kind: 'symbol', text: 'buildReport' },
      { kind: 'symbol', text: 'MAX_FILE_BYTES' },
      { kind: 'symbol', text: 'prune' },
    ])
  })

  test('plain words in a code span yield nothing', () => {
    expect(one('`true` `kanon` `the user` `ab()` `1.0`')).toEqual([])
  })

  test('@path imports are paths', () => {
    expect(one('@docs/guide.md\nand (@src/discover/imports.ts) too')).toEqual([
      { kind: 'path', text: 'docs/guide.md' },
      { kind: 'path', text: 'src/discover/imports.ts' },
    ])
  })

  test('an @mention that is not path-shaped is not a name', () => {
    expect(one('thanks @someone for this')).toEqual([])
  })

  test('bare path tokens in prose are paths', () => {
    expect(one('Edit src/discover/walk.ts and hooks/scripts/record.sh now.')).toEqual([
      { kind: 'path', text: 'src/discover/walk.ts' },
      { kind: 'path', text: 'hooks/scripts/record.sh' },
    ])
  })

  test('prose with a slash is not a path', () => {
    expect(one('Use and/or input/output, on 2026/10/24, see https://example.com/a/b.html')).toEqual([])
  })

  test('fenced blocks are ignored', () => {
    expect(one('```\n`src/gone.ts` src/also/gone.ts --nope\n```\n~~~\n`other/gone.ts`\n~~~\n')).toEqual([])
  })

  test('front matter is ignored', () => {
    expect(one('---\nname: `src/fm.ts`\npaths: src/fm/a.ts\n---\nBody `src/body.ts`')).toEqual([
      { kind: 'path', text: 'src/body.ts' },
    ])
  })

  test('the same name twice appears once, in first-seen order', () => {
    expect(one('`src/a.ts` then src/b.ts then `src/a.ts` and src/b.ts')).toEqual([
      { kind: 'path', text: 'src/a.ts' },
      { kind: 'path', text: 'src/b.ts' },
    ])
  })

  test('dotted identifiers are not paths, known file names still are', () => {
    expect(one('`Object.keys` `path.join`')).toEqual([])
    expect(one('`CLAUDE.md` `package.json` `.env`')).toEqual([
      { kind: 'path', text: 'CLAUDE.md' },
      { kind: 'path', text: 'package.json' },
      { kind: 'path', text: '.env' },
    ])
  })

  test('yarn install is not a script', () => {
    expect(one('`yarn install`')).toEqual([])
  })

  test('--flag=value yields the flag alone', () => {
    expect(one('`--session=abc`')).toEqual([{ kind: 'flag', text: '--session' }])
  })

  test('a numeric extension in prose is not a path', () => {
    expect(one('version 1.0 and v1.2.3 shipped')).toEqual([])
  })

  test('an anchored extensionless path is a path', () => {
    expect(one('run ./x/y first')).toEqual([{ kind: 'path', text: './x/y' }])
  })

  test('a path inside a Markdown link is a path', () => {
    expect(one('[guide](docs/guide.md)')).toEqual([{ kind: 'path', text: 'docs/guide.md' }])
  })

  // Names that are path-shaped and are not paths. Each one was a false
  // `gone` in a live brief.
  const paths = (md: string) => one(md).filter((n) => n.kind === 'path').map((n) => n.text)

  test('a slash command is not a path', () => {
    expect(paths('Run `/kanon`, `/mcp` or `/kanon:report`, or type /kanon in prose.')).toEqual([])
  })

  test('an anchored name outside the filesystem roots is not a path', () => {
    expect(paths('IDs look like `/org/project`; ignore `/.superpowers/` in git.')).toEqual([])
  })

  test('an absolute path under a filesystem root is still a path', () => {
    expect(paths('See `/home/user/x.md`, `/tmp/a` and /etc/hosts/x.conf.')).toEqual(['/home/user/x.md', '/tmp/a', '/etc/hosts/x.conf'])
  })

  test('a URL with no scheme is not a path', () => {
    expect(paths('Read `docs.example.com/en/hooks`, github.com/user/repo and see www.example.org/a/b.')).toEqual([])
  })

  test('a file name with an extension still counts in the first segment', () => {
    expect(paths('Edit `config.json/x` and `src/a.ts`.')).toEqual(['config.json/x', 'src/a.ts'])
  })

  test('a placeholder segment is not a path', () => {
    expect(paths('Write `state/<id>.json`, `src/{name}.ts` and `~/.kanon/<session>/x`.')).toEqual([])
  })

  test('ordinary names are still taken', () => {
    expect(paths('Use `src/a.ts`, `~/.kanon/state/`, `/home/user/x.md` and `CLAUDE.md`.')).toEqual([
      'src/a.ts',
      '~/.kanon/state/',
      '/home/user/x.md',
      'CLAUDE.md',
    ])
  })
})
