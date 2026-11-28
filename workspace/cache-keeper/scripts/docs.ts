/**
 * Renders the parts of docs/*.md that the code already knows, between markers:
 *
 *   <!-- gen:NAME -->  ...generated...  <!-- /gen:NAME -->
 *
 * The prose around the markers is written by hand; what sits between them comes
 * from the code that does the work, so it cannot drift from it:
 *
 *   settings          src/config.ts SETTINGS, defaults from settingsOf() on an empty config
 *   handoff-settings  the `handoff.*` part of the same list
 *   cold-stop-settings  the `coldStop.*` part of it
 *   status-lines      hooks/status.ts STATUS_EXAMPLES, made by the real format()
 *   ledger-events     src/ledger.ts LEDGER_EVENTS, the table the event type is derived from
 *   module PATH       the module header of PATH (its first doc comment)
 *   guardrails        every INVARIANT / WORKAROUND / WARNING comment in src, hooks, bin
 *   ref NAME          a link to the exported NAME (file#line) and the first paragraph of its
 *                     doc comment; the fields stay in the code, the doc only points there
 *
 * Inside a sentence, a link alone:  <!--ref:NAME-->...<!--/ref-->
 *
 *   node scripts/docs.ts          rewrite the docs in place
 *   node scripts/docs.ts --check  exit 1 and name the stale files; writes nothing
 *
 * test/docs.test.ts runs the check, so CI fails on docs that no longer match the code.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, SETTINGS, type SettingDoc } from '../src/config.ts'
import { settingsOf } from '../src/inspect.ts'
import { LEDGER_EVENTS } from '../src/ledger.ts'
// @ts-ignore TS5097
import { STATUS_EXAMPLES } from '../hooks/status.ts'

export const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')

/** The values settingsOf reports with no env and no config.json: the defaults. */
function defaults(): Map<string, string> {
  const env = { CTX_KEEPER_HOME: join(tmpdir(), 'cache-keeper-docs-no-such-home') }
  return new Map(settingsOf(loadConfig(env), env).map((s) => [s.key, s.value]))
}

const code = (s: string): string => `\`${s}\``

function defaultOf(s: SettingDoc, known: Map<string, string>): string {
  if (s.defaultText !== undefined) return s.defaultText
  const v = s.key === undefined ? undefined : known.get(s.key)
  if (v === undefined || v === '-') return '—'
  return s.key === 'maxPings' ? `auto, from ${code(v)}` : code(v)
}

function settingsTable(rows: readonly SettingDoc[], keyOf: (s: SettingDoc) => string): string {
  const known = defaults()
  const lines = ['| key | env | default | meaning |', '|---|---|---|---|']
  for (const s of rows) {
    lines.push(`| ${s.key === undefined ? '—' : code(keyOf(s))} | ${s.env === undefined ? '—' : code(s.env)} | ${defaultOf(s, known)} | ${s.meaning} |`)
  }
  return lines.join('\n')
}

const isHandoff = (s: SettingDoc): boolean => s.key?.startsWith('handoff.') === true
const isColdStop = (s: SettingDoc): boolean => s.key?.startsWith('coldStop.') === true

const REPO = join(DOCS_DIR, '..')

/** The leading `/** … *\/` of a source file, as plain markdown lines. */
export function moduleHeader(path: string): string {
  const src = readFileSync(join(REPO, path), 'utf8')
  if (path.endsWith('.sh')) {
    const lines = src.split('\n').slice(src.startsWith('#!') ? 1 : 0)
    const end = lines.findIndex((l) => !l.startsWith('#'))
    const header = lines.slice(0, end === -1 ? lines.length : end).map((l) => l.replace(/^# ?/, ''))
    if (header.length === 0) throw new Error(`${path} has no module header`)
    return header.join('\n').trim()
  }
  const m = /^(?:#![^\n]*\n)?\s*\/\*\*([\s\S]*?)\*\//.exec(src)
  if (m === null) throw new Error(`${path} has no module header`)
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim()
}

const GUARD = /^\s*(?:\/\/|#) (INVARIANT|WORKAROUND|WARNING): (.*)$/
const SOURCE_DIRS = ['src', 'hooks', 'bin']

/** Every guard comment in the shipped code, with its continuation lines, grouped by kind. */
export function guardrails(): string {
  const found: Record<string, string[]> = { INVARIANT: [], WORKAROUND: [], WARNING: [] }
  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(join(REPO, dir)).filter((f) => /\.(ts|sh)$/.test(f)).sort()) {
      const lines = readFileSync(join(REPO, dir, file), 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = GUARD.exec(lines[i])
        if (m === null) continue
        const marker = lines[i].trimStart().startsWith('#') ? '#' : '//'
        let text = m[2]
        // a guard comment goes on over the plain comment lines right below it
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j].trim()
          // a compiler directive (`// @ts-ignore`) right below is code, not more of the guard
          if (!t.startsWith(`${marker} `) || t.startsWith(`${marker} @`) || GUARD.test(lines[j])) break
          text += ` ${t.slice(marker.length + 1)}`
        }
        found[m[1]].push(`- [\`${dir}/${file}:${i + 1}\`](../${dir}/${file}#L${i + 1}) ${text}`)
      }
    }
  }
  const title: Record<string, string> = { INVARIANT: 'Invariants', WORKAROUND: 'Workarounds', WARNING: 'Warnings' }
  return Object.entries(found)
    .filter(([, rows]) => rows.length > 0)
    .map(([kind, rows]) => `## ${title[kind]}\n\n${rows.join('\n')}`)
    .join('\n\n')
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An exported declaration of NAME at the start of a line (not a re-export `export { NAME }`). */
export const declOf = (name: string): RegExp =>
  new RegExp(
    `^export (?:declare )?(?:default )?(?:abstract )?(?:(?:const enum|enum|interface|type|const|let|var|class|namespace|module|(?:async )?function) |(?:async )?function\\* ?)${escapeRe(name)}(?![\\w$])`,
  )

export interface SymbolRef {
  path: string
  line: number
  /** First paragraph of the doc comment right above the declaration, if any. */
  summary?: string
}

function refFiles(root: string): string[] {
  return SOURCE_DIRS.filter((dir) => existsSync(join(root, dir)))
    .flatMap((dir) =>
      (readdirSync(join(root, dir), { recursive: true }) as string[])
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `${dir}/${f}`),
    )
    .sort()
}

/**
 * Where the exported NAME is declared under ROOT. Overloads and merged interfaces in one file
 * count as one symbol (the first one with a doc comment wins, else the first); declarations in two
 * files are an error, as is none.
 */
export function findSymbol(name: string, root: string = REPO): SymbolRef {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`ref: "${name}" is not an identifier`)
  const decl = declOf(name)
  const hits: SymbolRef[] = []
  for (const path of refFiles(root)) {
    const lines = readFileSync(join(root, path), 'utf8').replace(/^﻿/, '').split('\n')
    lines.forEach((l, i) => {
      if (decl.test(l)) hits.push({ path, line: i + 1, summary: docAbove(lines, i) })
    })
  }
  const files = new Set(hits.map((h) => h.path))
  if (files.size !== 1) {
    const where = files.size === 0 ? 'nowhere' : `in ${files.size} files (${[...files].join(', ')})`
    throw new Error(`ref: ${name} is declared ${where} under ${SOURCE_DIRS.join(', ')}`)
  }
  return hits.find((h) => h.summary !== undefined) ?? hits[0]
}

/**
 * The first paragraph of the `/** … *\/` that ends on the line right above `at`: up to a blank
 * line or the first `@tag`, joined, `{@link X}` as `X`. Undefined when the comment above is not
 * a doc comment, so a plain `/* … *\/` never lends the symbol an earlier comment's text.
 */
export function docAbove(lines: string[], at: number): string | undefined {
  if (at === 0 || !lines[at - 1].trim().endsWith('*/')) return undefined
  // the closing line is the comment's own, not a code line with a trailing `/* … */`
  const close = lines[at - 1].trim()
  if (!close.startsWith('/*') && !close.startsWith('*') && close.includes('/*')) return undefined
  // walk up to the line that opens it; passing another `*/` means we left this comment
  let start = at - 1
  while (!lines[start].trim().startsWith('/*')) {
    if (start === 0 || lines[start - 1].includes('*/')) return undefined
    start--
  }
  if (!lines[start].trim().startsWith('/**')) return undefined
  const body = lines
    .slice(start, at)
    .map((l) => l.trim().replace(/^\/\*\*\s?/, '').replace(/\s?\*\/$/, '').replace(/^\*(?!\/)\s?/, '').trim())
  const para: string[] = []
  for (const l of body) {
    if (l.startsWith('@')) break
    if (l === '') {
      if (para.length > 0) break
      continue
    }
    para.push(l)
  }
  if (para.length === 0) return undefined
  return para.join(' ').replace(/\{@link(?:code|plain)?\s+([^}\s|]+)[^}]*\}/g, '`$1`')
}

// plain link text, no code span: backticks in the rendered link would pair with a stray backtick
// earlier in the paragraph and quote the whole ref, freezing it
const refLink = (name: string, r: SymbolRef): string => `[${name}](../${r.path}#L${r.line})`

/** The body of a `gen:ref NAME` block: the link and the summary, which the symbol must have. */
export function refLine(name: string, root: string = REPO): string {
  const r = findSymbol(name, root)
  if (r.summary === undefined) throw new Error(`ref: ${name} (${r.path}:${r.line}) has no doc comment to show`)
  return `${refLink(name, r)} — ${r.summary}`
}

export const GENERATORS: Record<string, (arg?: string) => string> = {
  ref: (name) => {
    if (name === undefined) throw new Error('gen:ref needs a name')
    return refLine(name)
  },
  module: (path) => {
    if (path === undefined) throw new Error('gen:module needs a path')
    return moduleHeader(path)
  },
  guardrails: () => guardrails(),
  settings: () =>
    `${settingsTable(
      SETTINGS.filter((s) => !isHandoff(s) && !isColdStop(s)),
      (s) => s.key ?? '',
    )}\n| ${code('handoff.*')} | | | see [Handoff](handoff.md) |\n| ${code('coldStop.*')} | | | see [Cold stop](cold-stop.md) |`,
  'handoff-settings': () =>
    settingsTable(
      SETTINGS.filter(isHandoff),
      (s) => (s.key ?? '').slice('handoff.'.length),
    ),
  'cold-stop-settings': () =>
    settingsTable(
      SETTINGS.filter(isColdStop),
      (s) => (s.key ?? '').slice('coldStop.'.length),
    ),
  'status-lines': () => STATUS_EXAMPLES.map((e: { text: string; meaning: string }) => `- ${code(e.text)}: ${e.meaning}.`).join('\n'),
  'ledger-events': () =>
    ['| event | one line means |', '|---|---|', ...Object.entries(LEDGER_EVENTS).map(([k, v]) => `| ${code(k)} | ${v} |`)].join('\n'),
}

// One pass over the doc as written, so every error names a line of the file on disk. Whichever
// starts first wins: a fence (``` or ~~~, any length) or a code span quotes whatever it holds,
// markers included; a gen block and an inline ref are rendered. The rendered link holds a code
// span itself, so a ref is matched whole, and its text may not hold another `<!--`, so an
// unpaired opener is never swallowed by the next ref's closer.
const TOKEN = new RegExp(
  [
    // indented or not, empty or not; an unclosed fence runs to the end of the doc. A backtick
    // fence's info string holds no backtick (CommonMark), so "```x``` text" stays an inline span
    String.raw`(?<fence>(?<=^|\n)[ \t]*(?<fmark>\`{3,}(?!\`)|~{3,}(?!~))(?:(?<=\`)[^\n\`]*|(?<=~)[^\n]*)(?=\n|$)(?:\n(?:[\s\S]*?\n)?[ \t]*\k<fmark>[\`~]*[ \t]*(?=\n|$)|[\s\S]*$))`,
    // a block body never holds another opener: a missing closer must not reach the next block's
    String.raw`(?<block><!-- gen:(?<gname>[a-z-]+)(?: (?<garg>[^ ]+))? -->\n(?:(?!<!-- gen:)[\s\S])*?<!-- \/gen:\k<gname> -->)`,
    String.raw`(?<ref><!--ref:(?<rname>[^ >-]+)-->(?:(?!<!--).)*?<!--\/ref-->)`,
    String.raw`(?<span>(?<tick>\`+)(?!\`)(?:(?!\n\n)[\s\S])*?(?<!\`)\k<tick>(?!\`))`,
  ].join('|'),
  'g',
)
// anything left in prose that looks like a marker is a typo, an unpaired or a wrapped one
const STRAY = /<!--\s*\/?\s*(?:ref\b|gen:)[^>]*-->/

/** The file with every block and ref re-rendered; a bad marker or symbol throws, naming file:line. */
export function render(text: string, file = 'doc'): string {
  const at = (offset: number): string => `${file}:${text.slice(0, offset).split('\n').length}`
  const located = (offset: number, make: () => string): string => {
    try {
      return make()
    } catch (e) {
      throw new Error(`${at(offset)}: ${(e as Error).message}`)
    }
  }
  const prose = (from: number, to: number): string => {
    const part = text.slice(from, to)
    const stray = STRAY.exec(part)
    if (stray !== null) throw new Error(`${at(from + stray.index)}: marker without its pair: ${stray[0]}`)
    return part
  }
  let out = ''
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const g = m.groups ?? {}
    out += prose(last, m.index)
    last = m.index + m[0].length
    if (g.block !== undefined) {
      const { gname: name, garg: arg } = g
      const gen = GENERATORS[name]
      if (gen === undefined) throw new Error(`${at(m.index)}: unknown generated block "${name}"`)
      const open = arg === undefined ? `<!-- gen:${name} -->` : `<!-- gen:${name} ${arg} -->`
      out += located(m.index, () => `${open}\n${gen(arg)}\n<!-- /gen:${name} -->`)
    } else if (g.ref !== undefined) {
      const name = g.rname
      out += located(m.index, () => `<!--ref:${name}-->${refLink(name, findSymbol(name))}<!--/ref-->`)
    } else {
      out += m[0]
    }
  }
  return out + prose(last, text.length)
}

/** Docs whose generated blocks differ from what the code renders now. */
export function staleDocs(dir: string = DOCS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      const text = readFileSync(join(dir, f), 'utf8')
      return render(text, f) !== text
    })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check')
  let stale: string[]
  try {
    stale = staleDocs()
  } catch (e) {
    console.error(`docs: ${(e as Error).message}`)
    process.exit(1)
  }
  if (check) {
    if (stale.length > 0) {
      console.error(`stale docs: ${stale.join(', ')}; run node scripts/docs.ts`)
      process.exit(1)
    }
  } else {
    for (const f of stale) writeFileSync(join(DOCS_DIR, f), render(readFileSync(join(DOCS_DIR, f), 'utf8'), f))
    console.log(stale.length === 0 ? 'docs up to date' : `rewrote ${stale.join(', ')}`)
  }
}
