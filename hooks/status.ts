/**
 * The status line: one pinned line under the prompt saying whether keeper is on
 * and until when this session's prompt cache stays warm, counted from the start
 * of the last model request, in the bucket it really wrote. It refreshes as each
 * request goes out, after each turn and every 30 s; a resumed session is read from
 * its transcript and keeper's ledger. Once cold, it says what the next turn costs
 * and, when cheaper, a new session's first turn; it also says when `node` on PATH
 * cannot run the hooks. Set `"statusLine": false` in config.json to turn it off.
 * Where the mod loads, band.ts draws the line above the prompt and this one
 * carries errors only (`"band": false` keeps it here).
 */

import type { EngineInterface as $ } from 'claude-code'
// @ts-ignore TS5097
import { bandOn, setBand } from './band.ts'

const EVERY_MS = 30_000
const AFTER_TURN_MS = 4_000
const NODE_CHECK_TIMEOUT_MS = 5_000

const DEFAULT_MAX_PINGS = 4
const DEFAULT_MIN_CTX_TOKENS = 20_000
// INVARIANT: a missing TTL reads as one hour: a wrong guess that way stays silent, the other way tells a person to pay for a re-read they did not need.
const DEFAULT_TTL_SEC = 3600
/** The time part warns this long before the end, or at half the TTL on a 5-minute cache. */
const WARN_SEC = 600
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
      /** Present when the end is near: min(10 min, half the TTL) left. */
      warn?: true
    }
  | {
      kind: 'expired'
      /** The next turn's prompt written into a new cache, USD; undefined in a record from before 0.6.7. */
      nextColdUsd?: number
      /** A new session's first turn, USD; present only when it is cheaper than `nextColdUsd`. */
      coldStartUsd?: number
    }

type Json = Record<string, unknown>

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const envNum = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined)
const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v)

export function shown(config: Json, env: { disabled?: string }): boolean {
  return config.enabled !== false && config.statusLine !== false && !truthy(env.disabled)
}

/** `requestedAt`, `requestedTtlSec`: this session's last model request seen by the mod (ms since the epoch) and the cache bucket it wrote. */
export function lineOf(
  session: Json | undefined,
  config: Json,
  env: { maxPings?: string; minCtxTokens?: string; minAgeSec?: string; disabled?: string },
  now: number,
  tuning?: Json,
  requestedAt?: number,
  requestedTtlSec?: number,
): Line | undefined {
  if (!shown(config, env)) return undefined
  const turnEnd = num(session?.lastTurnEndAt) ?? 0
  // WARNING: a fork ping renews the cache but never lastRequestAt (src/fork.ts leaves it: compact-check reads it as Claude Code's own clock),
  // so while forks hold the cache (forkPingsHeld, reset by each Stop) lastTurnEndAt, which a fork sets, is the later anchor.
  const forkRenewed = (num(session?.forkPingsHeld) ?? 0) > 0 ? turnEnd : 0
  const recorded = Math.max(num(session?.lastRequestAt) ?? turnEnd, forkRenewed)
  const lastSent = Math.max(recorded, requestedAt ?? 0)
  if (lastSent === 0) return { kind: 'ready' }
  const requestTtlSec = requestedAt !== undefined && requestedAt >= recorded ? requestedTtlSec : undefined
  const ttlSec = requestTtlSec ?? num(session?.cacheTtlSec) ?? num(config.cacheTtlSec) ?? DEFAULT_TTL_SEC
  const warmUntil = lastSent + ttlSec * 1000
  const nextColdUsd = num(session?.coldTurnUsd)
  if (now >= warmUntil) {
    if (nextColdUsd === undefined) return { kind: 'expired' }
    const coldStartUsd = num(session?.coldStartUsd)
    if (coldStartUsd !== undefined && coldStartUsd < nextColdUsd) return { kind: 'expired', nextColdUsd, coldStartUsd }
    return { kind: 'expired', nextColdUsd }
  }
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
  if (warmUntil - now <= Math.min(WARN_SEC, ttlSec / 2) * 1000) line.warn = true
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

/** The money part: `$spent+$next turn warm+$hold to the end` (the last only with pings coming), or `next $X` (and `⇄$Y`, a new session's first turn) once cold. */
export function costText(l: Line): string | undefined {
  if (l.kind === 'ready') return undefined
  if (l.kind === 'expired') {
    if (l.nextColdUsd === undefined) return undefined
    const next = `next ${usd(l.nextColdUsd)}`
    return l.coldStartUsd === undefined ? next : `${next} ⇄${usd(l.coldStartUsd)}`
  }
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
  { text: format({ kind: 'expired', nextColdUsd: 0.98 }, 0), meaning: 'the cache went cold; the next turn writes the whole context anew, at $0.98. Switching model costs nothing extra now' },
  {
    text: format({ kind: 'expired', nextColdUsd: 0.98, coldStartUsd: 0.3 }, 0),
    meaning: 'the same, and a new session would pay $0.30 for its first turn (its start prompt, written anew): the floor of a handoff, shown only when it is cheaper',
  },
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

let requested: { sid: string; at: number; ttlSec?: 300 | 3600 } | undefined

/** The bucket a usage object wrote: from the API's `cache_creation` split, or the same two fields flat (a `turn.step` result). */
// INVARIANT: src/transcript.ts `ttlOfUsage` is the source of this rule for the split form (the mod cannot import src/); keep the two in step.
export function ttlOfUsage(u: unknown): 300 | 3600 | undefined {
  if (!u || typeof u !== 'object') return undefined
  const flat = u as Json
  const split = flat.cache_creation && typeof flat.cache_creation === 'object' ? (flat.cache_creation as Json) : flat
  if ((num(split.ephemeral_1h_input_tokens) ?? 0) > 0) return 3600
  return (num(split.ephemeral_5m_input_tokens) ?? 0) > 0 ? 300 : undefined
}

/** Lines the client writes itself: they send no request. */
const LOCAL_ONLY = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/

function promptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
  return ''
}

/** When the request that a transcript line starts began, ms since the epoch; undefined for any other line. */
// INVARIANT: src/transcript.ts `requestStartFromLine` is the source of this rule (the mod cannot import src/); keep the two in step.
export function requestStartOf(line: string): number | undefined {
  if (!line.includes('"user"')) return undefined
  let rec: any
  try {
    rec = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!rec || rec.type !== 'user' || rec.isSidechain === true) return undefined
  const content = rec.message?.content
  const isToolResult = Array.isArray(content) && content.some((b: any) => b && typeof b === 'object' && b.type === 'tool_result')
  if (!isToolResult) {
    if (rec.isCompactSummary === true) return undefined
    const text = promptText(content)
    // The interrupt note is written after the request already went out and renewed the cache.
    if (LOCAL_ONLY.test(text) || text.startsWith('[Request interrupted')) return undefined
  }
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
  return Number.isFinite(ts) ? ts : undefined
}

const MAX_FUTURE_MS = 60_000

/**
 * A session with no record (resumed: SessionEnd deleted it) read from the tails of its transcript and of keeper's
 * ledger: the last request start, the bucket of the last write, and a ping that hit after it. Undefined when neither says anything.
 */
export function seedOf(transcriptTail: string, ledgerTail: string, sid: string, now: number): Json | undefined {
  let started: number | undefined
  let ttlSec: number | undefined
  const lines = transcriptTail.split('\n')
  for (let i = lines.length - 1; i >= 0 && (started === undefined || ttlSec === undefined); i--) {
    const line = lines[i] ?? ''
    if (started === undefined) started = requestStartOf(line)
    if (ttlSec === undefined && line.includes('"assistant"') && !line.includes('"isSidechain":true')) {
      try {
        ttlSec = ttlOfUsage(JSON.parse(line)?.message?.usage)
      } catch {
        // A torn or foreign line says nothing.
      }
    }
  }
  let hit = 0
  for (const line of ledgerTail.split('\n')) {
    if (!line.includes('"wake-hit"') || !line.includes(sid)) continue
    try {
      const e = JSON.parse(line)
      if (e.sessionId !== sid || e.event !== 'wake-hit') continue
      if ((num(e.cacheRead) ?? 0) + (num(e.cacheWrite) ?? 0) <= 0) continue
      const at = typeof e.t === 'string' ? Date.parse(e.t) : NaN
      if (!(at <= now + MAX_FUTURE_MS)) continue
      hit = Math.max(hit, at)
    } catch {
      // A torn line says nothing.
    }
  }
  const lastRequestAt = Math.max(started ?? 0, hit)
  if (lastRequestAt === 0) return undefined
  return { lastRequestAt, ...(ttlSec !== undefined ? { cacheTtlSec: ttlSec } : {}) }
}

const TAIL_BYTES = 256 * 1024

// Computed again only when a file changed size: an idle session refreshes every 30 s, and a tail of 256 KiB is not worth that.
let seedMemo: { key: string; seed: Json | undefined } | undefined

async function sizeOf($: $, path: string | undefined): Promise<number> {
  try {
    return path ? (await $.fs.stat(path)).size : -1
  } catch {
    return -1
  }
}

async function readTail($: $, path: string, size: number): Promise<string> {
  if (size < 0) return ''
  try {
    const offset = Math.max(0, size - TAIL_BYTES)
    const raw = await $.fs.read(path, { offset, length: size - offset })
    // The cut lands inside a line: drop that partial one.
    return offset > 0 ? raw.slice(raw.indexOf('\n') + 1) : raw
  } catch {
    return ''
  }
}

async function readSeed($: $, sid: string, home: string, now: number): Promise<Json | undefined> {
  try {
    const { transcriptPath } = await $.session.info()
    const ledgerPath = `${home}/ledger.jsonl`
    const [transcriptSize, ledgerSize] = await Promise.all([sizeOf($, transcriptPath), sizeOf($, ledgerPath)])
    const key = `${sid}|${transcriptPath}|${transcriptSize}|${ledgerSize}`
    if (seedMemo?.key === key) return seedMemo.seed
    const [transcript, ledger] = await Promise.all([transcriptPath ? readTail($, transcriptPath, transcriptSize) : '', readTail($, ledgerPath, ledgerSize)])
    const seed = seedOf(transcript, ledger, sid, now)
    seedMemo = { key, seed }
    return seed
  } catch {
    return undefined
  }
}

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
    const req = requested?.sid === sid ? requested : undefined
    if (session) seedMemo = undefined
    const line = lineOf(session ?? (await readSeed($, sid, home, now)),config ?? {}, env, now, tuning, req?.at, req?.ttlSec)
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
    const sid = await $.session.id()
    requested = { ...(requested?.sid === sid ? requested : {}), sid, at: await $.clock.now() }
  } catch {
    return
  }
  await refresh($)
}

/** Run by gate.ts's `turn.step` hook once a request has answered: its usage says which bucket it wrote. */
export function statusStepAnswered(usage: unknown): void {
  const ttlSec = ttlOfUsage(usage)
  if (ttlSec !== undefined && requested) requested.ttlSec = ttlSec
}

/** Run by gate.ts's `turn.complete` hook. */
export function statusTurnDone($: $): void {
  $.clock.after(AFTER_TURN_MS, () => refresh($))
}
