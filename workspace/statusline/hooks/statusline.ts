/**
 * The mod side of the status line: it draws hooks/line.ts's line in the
 * StatusLine site and the subagent decoration (hooks/agents.ts) in each agent
 * row, and on each `session.measure` hands the account's limits to the journal
 * and the barometer feed where they are turned on. Drawing reads only what is
 * already in memory; the facts are refreshed by the engine's own events and a
 * ten-second tick, and git and files are written by bin/statusline.ts. Under a
 * `statusLine` command of your own, the line goes on the row below its output.
 */

import type { EngineInterface as $, Register } from 'claude-code'
// WORKAROUND: Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and
// reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
// @ts-ignore TS5097
import { accountOf, lineText, modelName, planOf, stateOf, type Facts } from './line.ts'
// @ts-ignore TS5097
import { agentLabel } from './agents.ts'
// @ts-ignore TS5097
import { branchOfHead, cacheKey, candidatesOf, dirtyOf, gitFactsOf, parseCounts, passDue, workdirOf, type FsLike } from './gitfacts.ts'
// @ts-ignore TS5097
import { DEFAULT_PRICES, promptOf, rateFor } from '../../cache-keeper/src/prices.ts'

/** This package's place under the plugin root. */
export const PACKAGE_DIR = 'workspace/statusline'

/** Every setting, an env variable each; the README lists them from here. */
export const SETTINGS: ReadonlyArray<{ env: string; meaning: string }> = Object.freeze([
  { env: 'CTX_STATUSLINE_DISABLED', meaning: '`1` (or `true`, `yes`, `on`): no line and no agent decoration from this mod; the engine draws its own (a `statusLine` command, or nothing); `0` turns it back on' },
  { env: 'CTX_STATUSLINE_SESSION_URL', meaning: 'link `cc:<id8>` to this URL, `{id}` and `{id8}` filled in; the plan glyph links to it with `#plan`' },
  { env: 'CTX_STATUSLINE_ACCOUNTS', meaning: 'JSON object, config-dir name to account label (`{".claude-work2": "work 🔑work2"}`); a label other than the name after `.claude-` shows yellow' },
  { env: 'CTX_STATUSLINE_META_DIR', meaning: 'folder of session records `<session id>.json` (`display_state`, `plan_total`, `plan_open`, ...), relative to `CLAUDE_CONFIG_DIR`; unset, no state glyph and no plan' },
  { env: 'CTX_STATUSLINE_BRANCH_DIR', meaning: 'folder of files `<session id>` naming the branch the session works on, shown over the checked-out one; relative to `CLAUDE_CONFIG_DIR`' },
  { env: 'CTX_STATUSLINE_IGNORE', meaning: '`:`-separated folders whose paths never pick the folder being worked on; a config dir (`~/.claude*`) never does' },
  { env: 'CTX_STATUSLINE_RATE_DIR', meaning: 'journal each whole-point step of the 5-hour and weekly limits to `<dir>/<config-dir name>.jsonl` (`RATE_LIMITS_DIR` is read too)' },
  { env: 'CTX_STATUSLINE_BAROMETER', meaning: 'write the limits to this file for the AI Usage Barometer SwiftBar plugin (`AI_USAGE_CLAUDE_STATUS_CACHE` is read too)' },
  { env: 'CTX_STATUSLINE_CACHE_DIR', meaning: 'where the git counts every session shares live; default `~/.cache/claude-statusline` (`STATUSLINE_CACHE_DIR` is read too)' },
] satisfies Array<{ env: string; meaning: string }>)

const TICK_MS = 10_000
const WORKDIR_EVERY_MS = 5_000
const CLI_TIMEOUT_MS = 30_000
/** Messages back the worked-on folder is looked for in. */
const WORKDIR_MESSAGES = 40

interface Settings {
  disabled: boolean
  home: string
  configDir: string
  sessionUrl?: string
  accounts: Record<string, string>
  metaDir?: string
  branchDir?: string
  ignore: string[]
  rateDir?: string
  barometer?: string
  cacheDir: string
}

let settings: Settings | undefined
let loading: Promise<Settings> | undefined
let started = false
/** Started and not turned off: only then do the turn's events refresh anything. */
let live = false
const facts: Facts = {}
let text: string | undefined
let turn = { inUsd: 0, outUsd: 0 }
let workdirAt = 0

const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== '' ? v.trim() : undefined)

function expand(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? `${home}${p.slice(1)}` : p
}

function within(p: string | undefined, base: string, home: string): string | undefined {
  if (p === undefined) return undefined
  const x = expand(p, home)
  return x.startsWith('/') ? x : `${base}/${x}`
}

/** The environment the line reads, every name spelled out: the validator lists what a mod reads. */
export interface SettingsEnv {
  HOME?: string
  CLAUDE_CONFIG_DIR?: string
  XDG_CACHE_HOME?: string
  CTX_STATUSLINE_DISABLED?: string
  CTX_STATUSLINE_SESSION_URL?: string
  CTX_STATUSLINE_ACCOUNTS?: string
  CTX_STATUSLINE_META_DIR?: string
  CTX_STATUSLINE_BRANCH_DIR?: string
  CTX_STATUSLINE_IGNORE?: string
  CTX_STATUSLINE_RATE_DIR?: string
  RATE_LIMITS_DIR?: string
  CTX_STATUSLINE_BAROMETER?: string
  AI_USAGE_CLAUDE_STATUS_CACHE?: string
  CTX_STATUSLINE_CACHE_DIR?: string
  STATUSLINE_CACHE_DIR?: string
}

async function readEnv($: $): Promise<SettingsEnv> {
  const no = () => undefined
  const [HOME, CLAUDE_CONFIG_DIR, XDG_CACHE_HOME, CTX_STATUSLINE_DISABLED, CTX_STATUSLINE_SESSION_URL, CTX_STATUSLINE_ACCOUNTS, CTX_STATUSLINE_META_DIR, CTX_STATUSLINE_BRANCH_DIR, CTX_STATUSLINE_IGNORE, CTX_STATUSLINE_RATE_DIR, RATE_LIMITS_DIR, CTX_STATUSLINE_BAROMETER, AI_USAGE_CLAUDE_STATUS_CACHE, CTX_STATUSLINE_CACHE_DIR, STATUSLINE_CACHE_DIR] = await Promise.all([
    $.env.get('HOME').catch(no),
    $.env.get('CLAUDE_CONFIG_DIR').catch(no),
    $.env.get('XDG_CACHE_HOME').catch(no),
    $.env.get('CTX_STATUSLINE_DISABLED').catch(no),
    $.env.get('CTX_STATUSLINE_SESSION_URL').catch(no),
    $.env.get('CTX_STATUSLINE_ACCOUNTS').catch(no),
    $.env.get('CTX_STATUSLINE_META_DIR').catch(no),
    $.env.get('CTX_STATUSLINE_BRANCH_DIR').catch(no),
    $.env.get('CTX_STATUSLINE_IGNORE').catch(no),
    $.env.get('CTX_STATUSLINE_RATE_DIR').catch(no),
    $.env.get('RATE_LIMITS_DIR').catch(no),
    $.env.get('CTX_STATUSLINE_BAROMETER').catch(no),
    $.env.get('AI_USAGE_CLAUDE_STATUS_CACHE').catch(no),
    $.env.get('CTX_STATUSLINE_CACHE_DIR').catch(no),
    $.env.get('STATUSLINE_CACHE_DIR').catch(no),
  ])
  return { HOME, CLAUDE_CONFIG_DIR, XDG_CACHE_HOME, CTX_STATUSLINE_DISABLED, CTX_STATUSLINE_SESSION_URL, CTX_STATUSLINE_ACCOUNTS, CTX_STATUSLINE_META_DIR, CTX_STATUSLINE_BRANCH_DIR, CTX_STATUSLINE_IGNORE, CTX_STATUSLINE_RATE_DIR, RATE_LIMITS_DIR, CTX_STATUSLINE_BAROMETER, AI_USAGE_CLAUDE_STATUS_CACHE, CTX_STATUSLINE_CACHE_DIR, STATUSLINE_CACHE_DIR }
}

async function loadSettings($: $): Promise<Settings> {
  return settingsFrom(await readEnv($))
}

/** The settings an environment gives; pure, so the tests drive it. */
export function settingsFrom(env: SettingsEnv): Settings {
  const get = (k: keyof SettingsEnv) => nonEmpty(env[k])
  const home = get('HOME') ?? '/'
  const configDir = (get('CLAUDE_CONFIG_DIR') ?? `${home}/.claude`).replace(/\/+$/, '')
  let accounts: Record<string, string> = {}
  try {
    const parsed = JSON.parse(get('CTX_STATUSLINE_ACCOUNTS') ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      accounts = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    }
  } catch {
    // A table that does not parse labels nothing.
  }
  const xdg = get('XDG_CACHE_HOME')
  const rate = get('CTX_STATUSLINE_RATE_DIR') ?? get('RATE_LIMITS_DIR')
  const baro = get('CTX_STATUSLINE_BAROMETER') ?? get('AI_USAGE_CLAUDE_STATUS_CACHE')
  const cache = get('CTX_STATUSLINE_CACHE_DIR') ?? get('STATUSLINE_CACHE_DIR')
  const ignore = (get('CTX_STATUSLINE_IGNORE') ?? '').split(':').filter((s) => s !== '').map((s) => expand(s, home))
  const sessionUrl = get('CTX_STATUSLINE_SESSION_URL')
  const metaDir = within(get('CTX_STATUSLINE_META_DIR'), configDir, home)
  const branchDir = within(get('CTX_STATUSLINE_BRANCH_DIR'), configDir, home)
  return {
    disabled: /^(1|true|yes|on)$/i.test(get('CTX_STATUSLINE_DISABLED') ?? ''),
    home,
    configDir,
    accounts,
    ignore,
    cacheDir: cache !== undefined ? expand(cache, home) : `${xdg ?? `${home}/.cache`}/claude-statusline`,
    ...(sessionUrl !== undefined ? { sessionUrl } : {}),
    ...(metaDir !== undefined ? { metaDir } : {}),
    ...(branchDir !== undefined ? { branchDir } : {}),
    ...(rate !== undefined ? { rateDir: expand(rate, home) } : {}),
    ...(baro !== undefined ? { barometer: expand(baro, home) } : {}),
  }
}

function settingsOf($: $): Promise<Settings> {
  if (settings !== undefined) return Promise.resolve(settings)
  loading ??= loadSettings($).then((s) => (settings = s))
  return loading
}

const fsOf = ($: $): FsLike => ({ read: (p) => $.fs.read(p), stat: (p) => $.fs.stat(p) })

async function readJson($: $, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v = JSON.parse(await $.fs.read(path))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function redraw($: $): void {
  const next = lineText(facts)
  if (next === text) return
  text = next
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The next draw reads the new text anyway.
  }
}

function cli($: $, cmd: string, input: Record<string, unknown>): Promise<unknown> {
  return $.process
    .run(['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/${PACKAGE_DIR}/bin/statusline.ts`, cmd], { stdin: JSON.stringify(input), timeoutMs: CLI_TIMEOUT_MS })
    .catch(() => undefined)
}

async function refreshSession($: $, s: Settings): Promise<void> {
  const [id, model, usage] = await Promise.all([$.session.id(), $.session.model().catch(() => ''), $.session.usage().catch(() => undefined)])
  facts.sessionId = id
  if (s.sessionUrl !== undefined) facts.sessionHref = s.sessionUrl.replaceAll('{id8}', id.slice(0, 8)).replaceAll('{id}', id)
  const account = accountOf(s.configDir, s.accounts)
  if (account !== undefined) facts.account = account
  if (model !== '') facts.model = modelName(model)
  if (usage !== undefined) spendFrom(usage)
}

function spendFrom(u: { cost?: { usd: number }; context: { tokens?: number; window: number } }): void {
  facts.spend = {
    ...facts.spend,
    ...(u.cost !== undefined ? { totalUsd: u.cost.usd } : {}),
    ...(u.context.tokens !== undefined ? { context: { tokens: u.context.tokens, window: u.context.window } } : {}),
  }
}

async function refreshMeta($: $, s: Settings): Promise<void> {
  const id = facts.sessionId
  if (id === undefined || !/^[A-Za-z0-9_-]+$/.test(id)) return
  if (s.metaDir !== undefined) {
    const meta = await readJson($, `${s.metaDir}/${id}.json`)
    const state = stateOf(meta)
    const plan = planOf(meta, await $.clock.now())
    if (state === undefined) delete facts.state
    else facts.state = state
    if (plan === undefined) delete facts.plan
    else facts.plan = plan
  }
}

/** Counts the looks at the worked-on folder; only the newest one writes. It only grows, so a look still pending from before never matches. */
let workdirGen = 0
/** When the look in flight started, by the wall clock; undefined when none runs. */
let workdirSince: number | undefined
/** A look in flight this long is hung on an engine call: the next one may start, and the hung one's answer is dropped. */
const WORKDIR_HUNG_MS = 30_000
/** The folder worked on, whole: set with `facts.dir`, before its git refresh, so a refresh started after it uses it. */
let workdirPath: string | undefined

async function refreshWorkdir($: $, s: Settings): Promise<void> {
  // Claimed before the first await, so two callers in one turn of the loop cannot both pass; a clock that stepped back frees it.
  const now = Date.now()
  if (workdirSince !== undefined && now - workdirSince >= 0 && now - workdirSince < WORKDIR_HUNG_MS) return
  workdirSince = now
  const gen = ++workdirGen
  try {
    workdirAt = await $.clock.now()
    const cwd = await $.session.cwd()
    let inputs: unknown[] = []
    try {
      const rows = await $.session.messages({ last: WORKDIR_MESSAGES })
      if (Array.isArray(rows)) inputs = rows.filter((m) => m.role === 'assistant').flatMap((m) => m.toolUses.map((t) => t.input))
    } catch {
      // No rows to read: the session's own folder.
    }
    const dir = await workdirOf(fsOf($), cwd, candidatesOf(inputs, s.home, s.ignore))
    // A look the cap gave up on answers from older inputs than the one that started after it: it writes nothing.
    if (gen !== workdirGen) return
    workdirPath = dir
    facts.dir = dir.split('/').pop() || dir
    await refreshGit($, s, dir)
  } finally {
    if (gen === workdirGen) workdirSince = undefined
  }
}

let gitDirOf: { dir: string; gitDir?: string; top?: string } | undefined
/** Counts the git refreshes; only the newest one writes, so a tick and a look never mix two folders' facts. */
let gitGen = 0

async function refreshGit($: $, s: Settings, dir?: string): Promise<void> {
  const gen = ++gitGen
  const fs = fsOf($)
  const target = dir ?? workdirPath ?? (await $.session.cwd())
  let known = gitDirOf
  // A folder outside a repository is asked again each time: a `git init` or clone there shows up by the next tick.
  if (known?.dir !== target || known.gitDir === undefined) {
    const g = await gitFactsOf(fs, target)
    known = { dir: target, ...(g ? { gitDir: g.gitDir, top: g.top } : {}) }
  }
  const gitDir = known.gitDir
  let branch = gitDir === undefined ? undefined : branchOfHead(await fs.read(`${gitDir}/HEAD`).catch(() => ''))
  const id = facts.sessionId
  if (s.branchDir !== undefined && id !== undefined && /^[A-Za-z0-9_-]+$/.test(id)) {
    const working = (await fs.read(`${s.branchDir}/${id}`).catch(() => '')).trim()
    if (working !== '') branch = working
  }
  const cacheFile = gitDir === undefined ? undefined : `${s.cacheDir}/git/${cacheKey(gitDir)}`
  const [cached, cacheStat, index, head] = cacheFile === undefined || branch === undefined
    ? ['', undefined, undefined, undefined]
    : await Promise.all([
        fs.read(cacheFile).catch(() => ''),
        fs.stat(cacheFile).catch(() => undefined),
        fs.stat(`${gitDir}/index`).catch(() => undefined),
        fs.stat(`${gitDir}/HEAD`).catch(() => undefined),
      ])
  const nowSec = Math.floor((await $.clock.now()) / 1000)
  if (gen !== gitGen) return
  gitDirOf = known
  if (branch === undefined || gitDir === undefined || cacheFile === undefined) {
    delete facts.branch
    delete facts.dirty
    delete facts.ahead
    return
  }
  facts.branch = branch
  const counts = parseCounts(cached)
  const dirty = dirtyOf(counts)
  if (dirty === undefined) delete facts.dirty
  else facts.dirty = dirty
  if (counts.ahead === undefined) delete facts.ahead
  else facts.ahead = counts.ahead
  const cachedAt = cacheStat?.mtimeMs ?? 0
  const moved = (index?.mtimeMs ?? 0) > cachedAt || (head?.mtimeMs ?? 0) > cachedAt
  if (passDue(counts, nowSec, moved) !== undefined && known.top !== undefined) {
    void cli($, 'git', { workdir: known.top, gitDir, cacheFile })
  }
}

async function tick($: $): Promise<void> {
  try {
    const s = await settingsOf($)
    // A first refresh that failed is made up here, not on every draw.
    if (facts.sessionId === undefined) await refreshSession($, s)
    await Promise.all([refreshMeta($, s), facts.dir === undefined ? refreshWorkdir($, s) : refreshGit($, s)])
    redraw($)
  } catch {
    // INVARIANT: a refresh that fails keeps the last line: a status line must never break a session.
  }
}

/** At the first draw: the settings, then, unless the line is off, the facts and the tick. */
function start($: $): void {
  if (started) return
  started = true
  void (async () => {
    const s = await settingsOf($)
    if (s.disabled) return
    live = true
    $.clock.every(TICK_MS, () => void tick($))
    await refreshSession($, s)
    await Promise.all([refreshMeta($, s), refreshWorkdir($, s)])
    redraw($)
  })().catch(() => {})
}

/** The `ui.render` hook on `StatusLine`. */
export function renderStatusLine<E extends { props: { text: string | null; maxRows: number } }, R>($: $, e: E, next: (e: E) => R): R {
  start($)
  if (settings?.disabled || text === undefined) return next(e)
  const theirs = e.props.text
  const rows = typeof theirs === 'string' && theirs.trim() !== '' && e.props.maxRows >= 2 ? `${theirs.replace(/\n+$/, '')}\n${text}` : text
  return next({ ...e, props: { ...e.props, text: rows } })
}

/** The `ui.render` hook on `AgentRow`. */
export function renderAgentRow<
  E extends { props: { label: string; model?: string; tokenCount: number; contextWindowSize?: number; startTime: number; taskStatus: string; columns?: number } },
  R,
>($: $, e: E, next: (e: E) => R): R {
  if (settings?.disabled) return next(e)
  try {
    const p = e.props
    const label = agentLabel(p, p.label, Date.now(), p.columns)
    return next({ ...e, props: { ...p, label } })
  } catch {
    return next(e)
  }
}

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

async function recordLimits($: $, s: Settings, limits: readonly Limit[]): Promise<void> {
  if (s.rateDir === undefined && s.barometer === undefined) return
  const session = await $.session.id()
  const at = Math.floor((await $.clock.now()) / 1000)
  const account = s.configDir.split('/').pop() ?? ''
  const jobs: Promise<unknown>[] = []
  if (s.rateDir !== undefined && account !== '') jobs.push(cli($, 'rate', { dir: s.rateDir, account, session, at, limits }))
  if (s.barometer !== undefined) {
    const version = await $.session.version().then((v) => v.version).catch(() => null)
    jobs.push(cli($, 'barometer', { file: s.barometer, at, session, version, limits }))
  }
  await Promise.all(jobs)
}

/** The `session.measure` hook: the spend and context for the line, the limits for the journal. */
export async function measureSession<E extends { context: { tokens?: number; window: number }; rateLimits: readonly Limit[]; cost?: { usd: number }; changed: readonly string[] }, R>(
  $: $,
  e: E,
  next: (e: E) => R | Promise<R>,
): Promise<R> {
  try {
    const s = await settingsOf($)
    spendFrom(e)
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) void recordLimits($, s, e.rateLimits).catch(() => {})
    if (live) redraw($)
  } catch {
    // The figures come again at the next measurement.
  }
  return next(e)
}

type StepUsage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
}

/** A request's price split as the line shows it: everything read or written for the prompt, then the output. */
export function usageSplit(u: StepUsage): { inUsd: number; outUsd: number } {
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const write = n(u.cache_creation_input_tokens)
  const hour = Math.min(write, n(u.ephemeral_1h_input_tokens))
  const r = rateFor(u.model, DEFAULT_PRICES, promptOf({ inputTokens: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: write }))
  // A write that names no lifetime is priced as five minutes, as /cost prices it.
  const inUsd = (n(u.input_tokens) * r.input + n(u.cache_read_input_tokens) * r.cacheRead + hour * r.cacheWrite + (write - hour) * r.input * 1.25) / 1e6
  return { inUsd, outUsd: (n(u.output_tokens) * r.output) / 1e6 }
}

/** Called by the plugin's `turn.start` hook (cache-keeper's gate.ts): a main turn starts `Δ` over. */
export function statuslineTurnStarted($: $, e: { agentId?: string }): void {
  if (e.agentId !== undefined) return
  try {
    turn = { inUsd: 0, outUsd: 0 }
    if (facts.spend?.turn !== undefined) {
      const { turn: _, ...rest } = facts.spend
      facts.spend = rest
    }
    if (live) void settingsOf($).then((s) => refreshSession($, s)).then(() => redraw($)).catch(() => {})
  } catch {
    // The line keeps the last turn's price until the next step.
  }
}

/** Called by the plugin's `turn.step` hook once a request answered: its price joins this turn's, a subagent's too. */
export function statuslineStepAnswered($: $, e: { agentId?: string }, usage: unknown): void {
  try {
    if (usage && typeof usage === 'object' && typeof (usage as StepUsage).model === 'string') {
      const split = usageSplit(usage as StepUsage)
      turn = { inUsd: turn.inUsd + split.inUsd, outUsd: turn.outUsd + split.outUsd }
      facts.spend = { ...facts.spend, turn: { ...turn } }
    }
    if (!live) return
    redraw($)
    if (e.agentId === undefined) {
      void (async () => {
        if ((await $.clock.now()) - workdirAt < WORKDIR_EVERY_MS) return
        await refreshWorkdir($, await settingsOf($))
        redraw($)
      })().catch(() => {})
    }
  } catch {
    // The next step adds its own.
  }
}

/** The events only the status line hooks; `turn.start` and `turn.step` reach it through cache-keeper's (statuslineTurnStarted, statuslineStepAnswered). */
export function registerStatusline(on: Parameters<Register>[0]): void {
  on('ui.render', { component: 'StatusLine' }, ($, e, next) => renderStatusLine($, e, next))
  on('ui.render', { component: 'AgentRow' }, ($, e, next) => renderAgentRow($, e, next))
  on('session.measure', ($, e, next) => measureSession($, e, next))
}

/** For tests: every module variable back to a fresh load. */
export function resetForTest(): void {
  settings = undefined
  loading = undefined
  started = false
  live = false
  text = undefined
  turn = { inUsd: 0, outUsd: 0 }
  workdirAt = 0
  workdirSince = undefined
  workdirPath = undefined
  // A look or refresh still pending from before the reset must not match a fresh one's number.
  workdirGen++
  gitGen++
  gitDirOf = undefined
  for (const k of Object.keys(facts)) delete (facts as Record<string, unknown>)[k]
}
