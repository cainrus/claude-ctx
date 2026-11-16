/**
 * The status line: one pinned line under the prompt saying whether keeper is on
 * and until when this session's prompt cache stays warm, counted from the last
 * model request. It refreshes on load, as each request goes out, a few seconds
 * after each turn and every 30 s. A session continued from another one starts at
 * `ready`. It also says when `node` on PATH cannot run the hooks, which would
 * otherwise fail without a word. Set `"statusLine": false` in config.json to turn
 * it off, e.g. when your own statusLine command already shows keeper. Where the
 * mod loads, band.ts draws the same line above the prompt with buttons, and this
 * line carries errors only (`"band": false` keeps it here).
 */

import type { EngineInterface as $ } from 'claude-code'
// @ts-ignore TS5097
import { bandOn, setBand } from './band.ts'

const EVERY_MS = 30_000
const AFTER_TURN_MS = 4_000
const NODE_CHECK_TIMEOUT_MS = 5_000

const DEFAULT_MAX_PINGS = 4
const DEFAULT_MIN_CTX_TOKENS = 20_000
const DEFAULT_TTL_SEC = 3600
/** As src/policy.ts THRESHOLDS.minAgeSec: the cache age at which keeper pings. */
const DEFAULT_MIN_AGE_SEC = 50 * 60

export const NODE_ERROR = 'error: needs Node.js ≥ 22.18'

export type Line =
  | { kind: 'ready' }
  | {
      kind: 'cached'
      /** Pings keeper may still send in this stretch. */
      left: number
      /** Whether a ping can still come; false makes the deadline final. */
      extends: boolean
      /** When the cache goes cold if nothing else is sent, ms since the epoch. */
      warmUntil: number
      /**
       * When it goes cold at the earliest if every ping left goes out and hits, ms since the
       * epoch; equal to `warmUntil` when no ping is coming. A ping goes out once the cache is
       * minAgeSec old and renews it from then, so each one adds at least minAgeSec.
       */
      heldUntil: number
      /** What this session's pings have cost so far, USD (`pingCostUsd` of its record). */
      pingsUsd: number
      /** The next turn's prompt read from this cache, USD; undefined in a record from before 0.6.7. */
      nextWarmUsd?: number
      /** Every ping left, each a read of the context: holding the cache to `heldUntil`, USD. */
      holdUsd?: number
    }
  | {
      kind: 'expired'
      /** The next turn's prompt written into a new cache, USD; undefined in a record from before 0.6.7. */
      nextColdUsd?: number
    }

type Json = Record<string, unknown>

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const envNum = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined)
const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v)

export function shown(config: Json, env: { disabled?: string }): boolean {
  return config.enabled !== false && config.statusLine !== false && !truthy(env.disabled)
}

/** `requestedAt`: this session's last model request seen by the mod, ms since the epoch. */
export function lineOf(
  session: Json | undefined,
  config: Json,
  env: { maxPings?: string; minCtxTokens?: string; minAgeSec?: string; disabled?: string },
  now: number,
  tuning?: Json,
  requestedAt?: number,
): Line | undefined {
  if (!shown(config, env)) return undefined
  const lastSent = Math.max(num(session?.lastTurnEndAt) ?? 0, requestedAt ?? 0)
  if (lastSent === 0) return { kind: 'ready' }
  const warmUntil = lastSent + (num(config.cacheTtlSec) ?? DEFAULT_TTL_SEC) * 1000
  const nextColdUsd = num(session?.coldTurnUsd)
  if (now >= warmUntil) return nextColdUsd === undefined ? { kind: 'expired' } : { kind: 'expired', nextColdUsd }
  // INVARIANT: mirrors keeper's rules (src/config.ts resolution order, policy.ts muting on a miss or done); the mod cannot import them.
  const max = envNum(env.maxPings) ?? num(config.maxPings) ?? num(tuning?.maxPings) ?? DEFAULT_MAX_PINGS
  const left = Math.max(0, max - (num(session?.pingsSoFar) ?? 0))
  const bigEnough = (num(session?.ctxTokens) ?? 0) >= (envNum(env.minCtxTokens) ?? num(config.minCtxTokens) ?? DEFAULT_MIN_CTX_TOKENS)
  const muted = session?.doneAt !== undefined || session?.lastPingHit === false
  const minAgeMs = (envNum(env.minAgeSec) ?? num(config.minAgeSec) ?? DEFAULT_MIN_AGE_SEC) * 1000
  // A ping that waits past the TTL finds the cache cold and holds nothing.
  const extendsIt = left > 0 && bigEnough && !muted && minAgeMs < warmUntil - lastSent
  const heldUntil = extendsIt ? warmUntil + left * minAgeMs : warmUntil
  const pingsUsd = Math.max(0, num(session?.pingCostUsd) ?? 0)
  const line: Line = { kind: 'cached', left, extends: extendsIt, warmUntil, heldUntil, pingsUsd }
  const nextWarmUsd = num(session?.warmTurnUsd)
  if (nextWarmUsd !== undefined) Object.assign(line, { nextWarmUsd, holdUsd: heldUntil > warmUntil ? left * nextWarmUsd : 0 })
  return line
}

const usd = (v: number): string => `$${v.toFixed(2)}`

const hhmmAt = (at: number, offsetMin: number): string => {
  const local = new Date(at - offsetMin * 60_000)
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}

/** The time part: `◉ 14:00→~16:35` while pings can hold the cache, `◉ 14:00` when that end is final. */
export function timeText(l: Line, offsetMin: number): string {
  if (l.kind === 'ready') return '○ ready'
  if (l.kind === 'expired') return '○ cold'
  const sure = hhmmAt(l.warmUntil, offsetMin)
  return l.heldUntil > l.warmUntil ? `◉ ${sure}→~${hhmmAt(l.heldUntil, offsetMin)}` : `◉ ${sure}`
}

/** The money part: `$spent+$next turn warm+$hold to the end` (the last only with pings coming), or `next $X` once cold. */
export function costText(l: Line): string | undefined {
  if (l.kind === 'ready') return undefined
  if (l.kind === 'expired') return l.nextColdUsd === undefined ? undefined : `next ${usd(l.nextColdUsd)}`
  if (l.nextWarmUsd === undefined) return undefined
  const parts = [l.pingsUsd, l.nextWarmUsd, ...(l.holdUsd ? [l.holdUsd] : [])]
  return parts.map(usd).join('+')
}

export function format(l: Line, offsetMin: number): string {
  const cost = costText(l)
  if (cost === undefined) return timeText(l, offsetMin)
  return l.kind === 'expired' ? `${timeText(l, offsetMin)} · ${cost}` : `${timeText(l, offsetMin)}  ${cost}`
}

/** The line while a hook of this session has a failure on record (`lastError`, src/errors.ts). */
export function errorLine(session: Json | undefined, home: string): string | undefined {
  const e = session?.lastError
  if (!e || typeof e !== 'object') return undefined
  const cmd = (e as Json).cmd
  return `error: ${typeof cmd === 'string' ? cmd : 'a hook'} failed · ${home}/errors.log`
}

const EXAMPLE_AT = Date.UTC(2026, 0, 1, 14, 5)

export const STATUS_EXAMPLES: ReadonlyArray<{ text: string; meaning: string }> = Object.freeze([
  { text: format({ kind: 'ready' }, 0), meaning: 'keeper is on; nothing has been sent in this session yet' },
  {
    text: format({ kind: 'cached', left: 3, extends: true, warmUntil: EXAMPLE_AT, heldUntil: EXAMPLE_AT + 150 * 60_000, pingsUsd: 0.17, nextWarmUsd: 0.05, holdUsd: 0.15 }, 0),
    meaning:
      'the cache stays warm until 14:05 for sure, and keeper can extend it: if every ping left in this stretch (3 here) ' +
      'goes out, it holds until about 16:35. That end is the earliest one: a ping goes out once the cache is `minAgeSec` ' +
      'old (50 min) and renews it from then. The money: $0.17 this session\'s pings cost so far, $0.05 the next turn\'s ' +
      'prompt read from this cache, $0.15 the pings left (each a read of the context). A ping still needs you back within ' +
      '`awaySec` and the away budget unspent: the line cannot see your keyboard, so away longer than that, 14:05 is final after all',
  },
  {
    text: format({ kind: 'cached', left: 0, extends: false, warmUntil: EXAMPLE_AT, heldUntil: EXAMPLE_AT, pingsUsd: 0.17, nextWarmUsd: 0.05, holdUsd: 0 }, 0),
    meaning: 'no ping is coming (none left, the context is too small to hold, the session is muted, or a ping missed), so 14:05 is final',
  },
  { text: format({ kind: 'expired', nextColdUsd: 0.98 }, 0), meaning: 'the cache went cold; the next turn writes the whole context anew, at $0.98' },
  { text: NODE_ERROR, meaning: '`node` on `PATH` is missing or too old to run the hooks, so keeper does nothing' },
  {
    text: errorLine({ lastError: { cmd: 'record' } }, '~/.claude-cache-keeper') ?? '',
    meaning:
      'a hook of this session threw. Hooks still exit 0 (a session is never broken by keeper), but each failure is ' +
      'logged there, counted by `report`, shown by `/cache-keeper:status`, and, without mods, told once an hour on ' +
      "the session's next prompt. The line goes away once a turn is recorded cleanly",
  },
  { text: '(nothing)', meaning: 'keeper is off, or `"statusLine": false`' },
])

/** Whether this `node --version` output runs `.ts` without a flag: 22.18+, 23.6+, any 24+. */
export function nodeOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\./.exec(version.trim())
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
}

let nodeBroken: boolean | undefined

let requested: { sid: string; at: number } | undefined

async function checkNode($: $): Promise<void> {
  try {
    const { exitCode, stdout } = await $.process.run(['node', '--version'], { timeoutMs: NODE_CHECK_TIMEOUT_MS })
    nodeBroken = exitCode !== 0 || !nodeOk(stdout)
  } catch {
    nodeBroken = true
  }
}

async function readJson($: $, path: string): Promise<Json | undefined> {
  try {
    const v = JSON.parse(await $.fs.read(path))
    return v && typeof v === 'object' ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

export async function refresh($: $): Promise<void> {
  try {
    const sid = await $.session.id()
    const home = (await $.env.get('CACHE_KEEPER_HOME')) ?? `${await $.env.get('HOME')}/.claude-cache-keeper`
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) return clear($, undefined)
    const [session, config, tuning] = await Promise.all([
      readJson($, `${home}/sessions/${sid}.json`),
      readJson($, `${home}/config.json`),
      readJson($, `${home}/tuning.json`),
    ])
    const env = {
      maxPings: await $.env.get('CACHE_KEEPER_MAX_PINGS'),
      minCtxTokens: await $.env.get('CACHE_KEEPER_MIN_CTX_TOKENS'),
      minAgeSec: await $.env.get('CACHE_KEEPER_MIN_AGE_SEC'),
      disabled: await $.env.get('CACHE_KEEPER_DISABLED'),
    }
    // Errors stay on the status line even with the band on: it is the one place every surface shows.
    if (nodeBroken) return clear($, shown(config ?? {}, env) ? NODE_ERROR : undefined)
    const failed = errorLine(session, home)
    if (failed !== undefined && shown(config ?? {}, env)) return clear($, failed)
    const now = await $.clock.now()
    const req = requested
    const line = lineOf(session, config ?? {}, env, now, tuning, req?.sid === sid ? req.at : undefined)
    const offsetMin = new Date(line?.kind === 'cached' ? line.warmUntil : now).getTimezoneOffset()
    if (line !== undefined && bandOn(config ?? {})) {
      // The band draws the line with buttons; the status line would only repeat it.
      $.ui.status(undefined)
      setBand($, { line, offsetMin, muted: session?.doneAt !== undefined })
      return
    }
    clear($, line === undefined ? undefined : format(line, offsetMin))
  } catch {
    // INVARIANT: every failure clears the line: a status must never break a session.
    clear($, undefined)
  }
}

/** The status line set to `text`, and the band emptied: one of them speaks at a time. */
function clear($: $, text: string | undefined): void {
  $.ui.status(text)
  setBand($, undefined)
}

/** Run by gate.ts's `session.start` hook: a plugin has one hooks module. */
export function statusStarted($: $): void {
  void checkNode($).then(() => refresh($))
  $.clock.every(EVERY_MS, () => refresh($))
}

/** Run by gate.ts's `turn.step` hook as a main-thread request goes out. */
export async function statusRequested($: $): Promise<void> {
  try {
    requested = { sid: await $.session.id(), at: await $.clock.now() }
  } catch {
    return
  }
  await refresh($)
}

/** Run by gate.ts's `turn.complete` hook. */
export function statusTurnDone($: $): void {
  $.clock.after(AFTER_TURN_MS, () => refresh($))
}
