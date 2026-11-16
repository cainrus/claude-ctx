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
 *   status-lines      hooks/status.ts STATUS_EXAMPLES, made by the real format()
 *   ledger-events     src/ledger.ts LEDGER_EVENTS, the table the event type is derived from
 *   module PATH       the module header of PATH (its first doc comment)
 *   guardrails        every INVARIANT / WORKAROUND / WARNING comment in src, hooks, bin
 *
 *   node scripts/docs.ts          rewrite the docs in place
 *   node scripts/docs.ts --check  exit 1 and name the stale files; writes nothing
 *
 * test/docs.test.ts runs the check, so CI fails on docs that no longer match the code.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  const env = { CACHE_KEEPER_HOME: join(tmpdir(), 'cache-keeper-docs-no-such-home') }
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
const GUARD_DIRS = ['src', 'hooks', 'bin']

/** Every guard comment in the shipped code, with its continuation lines, grouped by kind. */
export function guardrails(): string {
  const found: Record<string, string[]> = { INVARIANT: [], WORKAROUND: [], WARNING: [] }
  for (const dir of GUARD_DIRS) {
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

export const GENERATORS: Record<string, (arg?: string) => string> = {
  module: (path) => {
    if (path === undefined) throw new Error('gen:module needs a path')
    return moduleHeader(path)
  },
  guardrails: () => guardrails(),
  settings: () =>
    `${settingsTable(
      SETTINGS.filter((s) => !isHandoff(s)),
      (s) => s.key ?? '',
    )}\n| ${code('handoff.*')} | | | see [Handoff](handoff.md) |`,
  'handoff-settings': () =>
    settingsTable(
      SETTINGS.filter(isHandoff),
      (s) => (s.key ?? '').slice('handoff.'.length),
    ),
  'status-lines': () => STATUS_EXAMPLES.map((e: { text: string; meaning: string }) => `- ${code(e.text)}: ${e.meaning}.`).join('\n'),
  'ledger-events': () =>
    ['| event | one line means |', '|---|---|', ...Object.entries(LEDGER_EVENTS).map(([k, v]) => `| ${code(k)} | ${v} |`)].join('\n'),
}

const BLOCK = /<!-- gen:([a-z-]+)(?: ([^ ]+))? -->\n[\s\S]*?<!-- \/gen:\1 -->/g

/** The file with every block re-rendered; an unknown block name throws. */
export function render(text: string): string {
  return text.replace(BLOCK, (_, name: string, arg: string | undefined) => {
    const gen = GENERATORS[name]
    if (gen === undefined) throw new Error(`unknown generated block "${name}"`)
    const open = arg === undefined ? `<!-- gen:${name} -->` : `<!-- gen:${name} ${arg} -->`
    return `${open}\n${gen(arg)}\n<!-- /gen:${name} -->`
  })
}

/** Docs whose generated blocks differ from what the code renders now. */
export function staleDocs(dir: string = DOCS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      const text = readFileSync(join(dir, f), 'utf8')
      return render(text) !== text
    })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check')
  const stale = staleDocs()
  if (check) {
    if (stale.length > 0) {
      console.error(`stale docs: ${stale.join(', ')}; run node scripts/docs.ts`)
      process.exit(1)
    }
  } else {
    for (const f of stale) writeFileSync(join(DOCS_DIR, f), render(readFileSync(join(DOCS_DIR, f), 'utf8')))
    console.log(stale.length === 0 ? 'docs up to date' : `rewrote ${stale.join(', ')}`)
  }
}
