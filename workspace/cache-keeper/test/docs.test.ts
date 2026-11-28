import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { declOf, docAbove, findSymbol, GENERATORS, refLine, render, staleDocs } from '../scripts/docs.ts'
import { loadConfig, SETTINGS } from '../src/config.ts'
import { settingsOf } from '../src/inspect.ts'

const NO_HOME = { CTX_KEEPER_HOME: join(tmpdir(), 'cache-keeper-docs-test-no-home') }

test('the docs match the code: run `node scripts/docs.ts` after changing SETTINGS, STATUS_EXAMPLES or LEDGER_EVENTS', () => {
  assert.deepEqual(staleDocs(), [])
})

test('every setting /ctx:status reports is documented, and every documented key exists', () => {
  const reported = settingsOf(loadConfig(NO_HOME), NO_HOME).map((s) => s.key)
  const documented = SETTINGS.flatMap((s) => (s.key === undefined ? [] : [s.key]))
  // env-only settings status still names by their Config field
  const envOnly: Record<string, string> = { delaySec: 'CTX_KEEPER_DELAY_SEC' }
  for (const key of reported) {
    const covered = documented.includes(key) || SETTINGS.some((s) => s.key === undefined && s.env === envOnly[key])
    assert.ok(covered, `${key} is reported but not in SETTINGS`)
  }
  // keys loadConfig reads but settingsOf does not list
  const notReported = new Set(['prices', 'handoff.closeCommand'])
  for (const key of documented) assert.ok(reported.includes(key) || notReported.has(key), `${key} is in SETTINGS but keeper never reads it`)
})

test('every documented env variable really drives the key it is documented for', () => {
  // a value each parser accepts and that differs from every default
  const sample = (key: string): string =>
    ['enabled', 'forkPings', 'handoff.enabled', 'handoff.closeAfterSpawn'].includes(key) ? '0'
      : key === 'coldStop.enabled' ? '1'
        : key === 'hitRatio' ? '0.5'
          : key.endsWith('Command') || key === 'skipIf' || key === 'coldStop.blockIf' ? 'true' : '7'
  for (const s of SETTINGS) {
    if (s.key === undefined || s.env === undefined) continue
    const name = s.env.replace(/=.*$/, '')
    const env = { ...NO_HOME, [name]: s.env.endsWith('=1') ? '1' : sample(s.key) }
    const row = settingsOf(loadConfig(env), env).find((r) => r.key === s.key)
    assert.equal(row?.source, 'env', `${name} does not set ${s.key}`)
  }
})

test('a ref points at the one declaration and shows the first paragraph of its doc comment', () => {
  const r = findSymbol('LedgerEntry')
  assert.equal(r.path, 'src/ledger.ts')
  assert.match(r.summary ?? '', /ledger\.jsonl/)
  assert.equal(
    render('<!-- gen:ref LedgerEntry -->\n<!-- /gen:ref -->'),
    `<!-- gen:ref LedgerEntry -->\n[LedgerEntry](../src/ledger.ts#L${r.line}) — ${r.summary}\n<!-- /gen:ref -->`,
  )
  // inline: the link alone, re-rendered from whatever stale text sat between the markers
  assert.equal(render('see <!--ref:LedgerEntry-->old.ts#L1<!--/ref--> here'), `see <!--ref:LedgerEntry-->[LedgerEntry](../src/ledger.ts#L${r.line})<!--/ref--> here`)
  // an empty fence above is closed: the ref after it is rendered, not quoted as the rest of the doc
  assert.equal(render('```\n```\nsee <!--ref:LedgerEntry-->x<!--/ref-->'), `\`\`\`\n\`\`\`\nsee <!--ref:LedgerEntry-->[LedgerEntry](../src/ledger.ts#L${r.line})<!--/ref-->`)
  // a stray backtick earlier in the paragraph does not quote the ref: the link holds no backtick to pair with
  const odd = render('the `odd <!--ref:LedgerEntry-->old<!--/ref-->')
  assert.equal(odd, `the \`odd <!--ref:LedgerEntry-->[LedgerEntry](../src/ledger.ts#L${r.line})<!--/ref-->`)
  // and a second render still sees the ref: a backtick in the link would pair with the stray one here
  assert.equal(render(odd.replace(`#L${r.line}`, '#L1')), odd)
  // a line opening with an inline ```span``` is not a fence: the ref after it is rendered
  assert.equal(render('```x``` quoted\n<!--ref:LedgerEntry-->x<!--/ref-->'), `\`\`\`x\`\`\` quoted\n<!--ref:LedgerEntry-->[LedgerEntry](../src/ledger.ts#L${r.line})<!--/ref-->`)
})

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A throwaway source tree: { 'src/a.ts': '...' } under a fresh temp dir, removed after the file's tests. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cache-keeper-docs-ref-'))
  roots.push(root)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

test('a symbol declared in two files is an error; overloads in one file are one symbol, the first documented wins', () => {
  const root = fixture({
    'src/a.ts': '/** In a. */\nexport const Dup = 1\n',
    'src/deep/b.ts': 'export const Dup = 2\n',
    'hooks/o.ts': '/** Overloaded. */\nexport function f(x: string): string\nexport function f(x: number): number\nexport function f(x: unknown) { return x }\n',
    'hooks/m.ts': 'export interface M { a: 1 }\n/** Merged. */\nexport interface M { b: 2 }\n',
  })
  assert.throws(() => findSymbol('Dup', root), /Dup is declared in 2 files \(src\/a\.ts, src\/deep\/b\.ts\)/)
  assert.deepEqual(findSymbol('f', root), { path: 'hooks/o.ts', line: 2, summary: 'Overloaded.' })
  assert.deepEqual(findSymbol('M', root), { path: 'hooks/m.ts', line: 3, summary: 'Merged.' })
})

test('a doc comment with blank or unstarred body lines is still the doc comment', () => {
  const root = fixture({
    'src/n.ts': '/**\n   Unstarred first line\n   goes on.\n\n   Second paragraph.\n */\nexport namespace Ns {}\n',
  })
  assert.equal(findSymbol('Ns', root).summary, 'Unstarred first line goes on.')
})

test('a ref to a renamed, missing or undocumented symbol fails the build, naming the doc line', () => {
  assert.throws(() => render('x\n<!--ref:NoSuchThing--><!--/ref-->', 'a.md'), /^Error: a\.md:2: ref: NoSuchThing is declared nowhere/)
  assert.throws(() => render('x\n\n<!-- gen:ref NoSuchThing -->\n<!-- /gen:ref -->', 'b.md'), /^Error: b\.md:3: ref: NoSuchThing is declared nowhere/)
  const root = fixture({ 'src/u.ts': '// a plain comment\nexport type Undocumented = string\n' })
  assert.throws(() => refLine('Undocumented', root), /Undocumented \(src\/u\.ts:2\) has no doc comment/)
  assert.throws(() => findSymbol('a.b'), /not an identifier/)
})

test('an error below a block that re-renders to another length names the line in the file, not in the output', () => {
  // the empty gen:ref pair grows by a line when rendered; the bad ref sits on line 4 of the file
  const doc = '<!-- gen:ref LedgerEntry -->\n<!-- /gen:ref -->\n\n<!--ref:NoSuchThing--><!--/ref-->'
  assert.throws(() => render(doc, 'c.md'), /^Error: c\.md:4: /)
  assert.throws(() => render('<!-- gen:ref LedgerEntry -->\n<!-- /gen:ref -->\n\nsee <!--ref:X--> here', 'd.md'), /^Error: d\.md:4: marker without its pair/)
})

test('a marker that is unpaired, wrapped or spaced is an error, not a silently stale link', () => {
  for (const text of [
    'see <!--ref:LedgerEntry--> here',
    'see <!--ref:LedgerEntry-->old\nwrapped<!--/ref-->',
    'see <!-- ref:LedgerEntry --><!--/ref-->',
    // an unpaired opener before a whole ref on the same line is not swallowed by its closer
    'see <!--ref:LedgerEntry--> and <!--ref:SessionState-->x<!--/ref-->',
    // a block opener whose close is missing or misspelt
    '<!-- gen:ref LedgerEntry -->\ntext\n<!-- /gen:refs -->',
    // a block missing its closer does not borrow the next block's and eat the prose between
    '<!-- gen:ref LedgerEntry -->\nold\n\nprose\n\n<!-- gen:ref SessionState -->\nold\n<!-- /gen:ref -->',
  ]) {
    assert.throws(() => render(text), /marker without its pair/, text)
  }
})

test('markers inside code are quoted, not rendered', () => {
  for (const text of [
    'write `<!--ref:NAME--><!--/ref-->` in a sentence',
    'write `x <!--ref:NAME--><!--/ref-->` too',
    'a ``double `<!--ref:NAME-->` span`` here',
    '```\n<!--ref:NAME--><!--/ref-->\n```',
    '~~~md\n<!--ref:NAME--><!--/ref-->\n~~~',
    '````\n```\n<!--ref:NAME-->\n```\n````',
    '```\n<!-- gen:ref NoSuchThing -->\n<!-- /gen:ref -->\n```',
    '- item\n\n    ```md\n    <!--ref:NAME--><!--/ref-->\n    ```',
    '```\n```\nthen `<!--ref:NAME--><!--/ref-->` quoted',
    'text\n```\n<!--ref:NAME--><!--/ref-->\nnever closed',
    '`<!-- gen:NAME -->` opens a block',
  ]) {
    assert.equal(render(text), text, text)
  }
})

test('declarations: every export form, the exact name only, a re-export is not one', () => {
  for (const l of [
    'export interface X {', 'export type X =', 'export const X =', 'export let X', 'export var X', 'export enum X {',
    'export const enum X {', 'export class X {', 'export abstract class X {', 'export default class X {',
    'export function X(', 'export function* X(', 'export async function X(', 'export declare const X:',
  ]) {
    assert.ok(declOf('X').test(l), l)
  }
  assert.ok(!declOf('FOO').test('export const FOO$bar = 1'))
  assert.ok(!declOf('FOO').test('export const FOOD = 1'))
  assert.ok(!declOf('Foo').test('export const enumFoo = 1'))
  assert.ok(!declOf('Foo').test('export typeFoo'))
  assert.ok(!declOf('X').test('export { X } from "./x.ts"'))
  assert.ok(declOf('$x').test('export const $x = 1'))
})

test('the summary is the doc comment right above, never an earlier one across a plain comment', () => {
  const at = (src: string): string | undefined => {
    const lines = src.split('\n')
    return docAbove(lines, lines.findIndex((l) => l.startsWith('export const B')))
  }
  assert.equal(at('/** Doc of A. */\nexport const A = 1\n/* eslint-disable-next-line */\nexport const B = 2'), undefined)
  assert.equal(at('/** Doc of A. */\nexport const A = 1 /* note */\nexport const B = 2'), undefined)
  assert.equal(at('/** Doc of A. */\nexport const A = 1\n// plain\nexport const B = 2'), undefined)
  // the first paragraph, joined; stops at a tag or a blank line; {@link X} as code
  assert.equal(at('/**\n * First sentence goes\n * on here, see {@link Foo}.\n *\n * More.\n */\nexport const B = 2'), 'First sentence goes on here, see `Foo`.')
  assert.equal(at('/**\n * Short.\n * @deprecated use C\n */\nexport const B = 2'), 'Short.')
  assert.equal(at('/** @internal */\nexport const B = 2'), undefined)
})

test('an unknown generated block is an error, not silently left alone', () => {
  assert.throws(() => render('<!-- gen:nope -->\n<!-- /gen:nope -->'), /unknown generated block "nope"/)
  assert.ok(Object.keys(GENERATORS).length >= 4)
})
