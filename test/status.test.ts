import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format, lineOf, nodeOk, refresh, requestStartOf, seedOf, statusRequested, statusStepAnswered, ttlOfUsage } from '../hooks/status.ts'
import { decide, THRESHOLDS } from '../src/policy.ts'
import { requestStartFromLine, ttlOfUsage as ttlOfUsageSrc } from '../src/transcript.ts'
import { assistantLine, REQUEST_START_AT, REQUEST_START_CASES, SID, TTL_OF_USAGE_CASES, userLine } from './helpers.ts'

const T = 1_800_000_000_000
const MIN = 60_000
const session = (over: Record<string, unknown> = {}) => ({ ctxTokens: 50_000, pingsSoFar: 1, lastTurnEndAt: T, ...over })
/** The default the status line assumes, minutes: the policy's own, written out to catch drift. */
const DEFAULT_MIN_AGE_MIN = 50
const PING_EVERY = DEFAULT_MIN_AGE_MIN * MIN
/** A line as lineOf builds it: with pings coming, each one left holds the cache PING_EVERY longer. */
const cached = (left: number, ext: boolean, warmUntil: number, pingsUsd = 0) => ({
  kind: 'cached' as const,
  left,
  extends: ext,
  warmUntil,
  heldUntil: ext ? warmUntil + left * PING_EVERY : warmUntil,
  pingsUsd,
})
const hhmm = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`
const pick = (l: ReturnType<typeof lineOf>) => {
  assert.equal(l?.kind, 'cached')
  return l as ReturnType<typeof cached>
}

test('a warm cache with pings left shows the sure end and how far the pings can hold it', () => {
  const l = lineOf(session(), { maxPings: 4 }, {}, T + 10 * MIN)
  assert.deepEqual(l, cached(3, true, T + 60 * MIN))
  // 3 pings, each at 50 min of cache age: 09:00 + 3 × 50 min.
  assert.equal(format(l!, 0), '◉ 09:00→~11:30')
})

test('the money: spent on pings, the next turn read warm, and the pings left; cold, the next turn written anew', () => {
  const s = session({ pingCostUsd: 0.17, warmTurnUsd: 0.05, coldTurnUsd: 0.98 })
  const l = pick(lineOf(s, { maxPings: 4 }, {}, T + 10 * MIN))
  assert.equal(l.holdUsd, 3 * 0.05)
  assert.equal(format(l, 0), '◉ 09:00→~11:30  $0.17+$0.05+$0.15')
  // Final: nothing to hold, so the third sum is left out.
  assert.equal(format(lineOf({ ...s, pingsSoFar: 4 }, { maxPings: 4 }, {}, T)!, 0), '◉ 09:00  $0.17+$0.05')
  assert.equal(format(cached(0, false, T, 0), 0), '◉ 08:00', 'a record from before the prices: no money shown')
  const cold = lineOf(s, {}, {}, T + 60 * MIN)
  assert.deepEqual(cold, { kind: 'expired', nextColdUsd: 0.98 })
  assert.equal(format(cold!, 0), '○ cold · next $0.98')
})

test('the far end is the earliest one: each ping adds minAgeSec, from env, config.json or the default', () => {
  assert.equal(pick(lineOf(session(), { maxPings: 2 }, {}, T)).heldUntil, T + 60 * MIN + 50 * MIN)
  assert.equal(pick(lineOf(session(), { maxPings: 2, minAgeSec: 40 * 60 }, {}, T)).heldUntil, T + 60 * MIN + 40 * MIN)
  assert.equal(pick(lineOf(session(), { maxPings: 2, minAgeSec: 40 * 60 }, { minAgeSec: '1800' }, T)).heldUntil, T + 60 * MIN + 30 * MIN)
  assert.equal(DEFAULT_MIN_AGE_MIN * 60, THRESHOLDS.minAgeSec, 'the line copies keeper policy, keep them equal')
  // A TTL shorter than minAgeSec: a ping would find the cache cold, so nothing is held and nothing is priced to hold.
  const short = pick(lineOf(session({ warmTurnUsd: 0.05 }), { maxPings: 2, cacheTtlSec: 300 }, {}, T))
  assert.equal(short.heldUntil, short.warmUntil)
  assert.equal(short.holdUsd, 0)
  assert.equal(short.extends, false, 'final, and no ping button on the band')
  const edge = pick(lineOf(session(), { maxPings: 2, cacheTtlSec: 3000 }, {}, T))
  assert.equal(edge.heldUntil, edge.warmUntil, 'a ping at exactly the TTL lands cold too')
})

test('the time is local: the offset is applied to both ends', () => {
  // getTimezoneOffset() is UTC − local in minutes: −120 is UTC+2.
  assert.equal(format(cached(1, true, T), -120), '◉ 10:00→~10:50')
})

test("the session's ping cost reads from its record, at a cent's precision", () => {
  assert.equal(format({ ...cached(1, true, T, 0.134), nextWarmUsd: 0.051, holdUsd: 0.051 }, 0), '◉ 08:00→~08:50  $0.13+$0.05+$0.05')
  assert.equal(pick(lineOf(session({ pingCostUsd: 0.2 }), {}, {}, T)).pingsUsd, 0.2)
  assert.equal(pick(lineOf(session({ pingCostUsd: 'x' }), {}, {}, T)).pingsUsd, 0)
})

test('no ping left, a small context or a muted session make the deadline final', () => {
  assert.equal(format(lineOf(session({ pingsSoFar: 4 }), { maxPings: 4 }, {}, T)!, 0), '◉ 09:00')
  assert.equal(pick(lineOf(session({ ctxTokens: 1000 }), {}, {}, T)).extends, false)
  assert.equal(pick(lineOf(session({ doneAt: T }), {}, {}, T)).extends, false)
  assert.equal(pick(lineOf(session({ lastPingHit: false }), {}, {}, T)).extends, false)
  assert.equal(pick(lineOf(session({ lastPingHit: true }), {}, {}, T)).extends, true)
  assert.equal(pick(lineOf(session({ pingsSoFar: 9 }), { maxPings: 4 }, {}, T)).left, 0)
})

test('a ping granted but not back renews nothing; a confirmed one moved lastTurnEndAt', () => {
  assert.deepEqual(lineOf(session({ lastPingAt: T + 30 * MIN }), {}, {}, T + 70 * MIN), { kind: 'expired' })
  assert.equal(pick(lineOf(session({ lastTurnEndAt: T + 30 * MIN }), {}, {}, T + 70 * MIN)).warmUntil, T + 90 * MIN)
})

test('the env cap wins over config.json, as in keeper itself', () => {
  assert.equal(pick(lineOf(session(), { maxPings: 4 }, { maxPings: '2' }, T)).left, 1)
  assert.equal(pick(lineOf(session(), { maxPings: 4 }, { maxPings: 'x' }, T)).left, 3)
  assert.equal(pick(lineOf(session(), { minCtxTokens: 1000 }, { minCtxTokens: '60000' }, T)).extends, false)
})

test('without a cap in env or config.json, the tuned one counts', () => {
  assert.equal(pick(lineOf(session(), {}, {}, T, { maxPings: 6 })).left, 5)
  assert.equal(pick(lineOf(session(), { maxPings: 2 }, {}, T, { maxPings: 6 })).left, 1)
  assert.equal(pick(lineOf(session(), {}, {}, T)).left, 3)
})

test('before anything was sent, keeper says it is ready', () => {
  assert.deepEqual(lineOf(undefined, {}, {}, T), { kind: 'ready' })
  assert.deepEqual(lineOf({ pingsSoFar: 0 }, {}, {}, T), { kind: 'ready' })
  assert.equal(format({ kind: 'ready' }, 0), '○ ready')
})

test('a request in the first turn, before any record, is cached with no renewal promised', () => {
  const l = lineOf(undefined, {}, {}, T + 5 * MIN, undefined, T)
  assert.deepEqual(l, cached(4, false, T + 60 * MIN))
  assert.equal(format(l!, 0), '◉ 09:00')
  assert.deepEqual(lineOf(undefined, {}, {}, T + 60 * MIN, undefined, T), { kind: 'expired' })
})

test('a request newer than the record moves the deadline; an older one does not', () => {
  assert.equal(pick(lineOf(session(), {}, {}, T + 50 * MIN, undefined, T + 40 * MIN)).warmUntil, T + 100 * MIN)
  assert.equal(pick(lineOf(session({ lastTurnEndAt: T + 30 * MIN }), {}, {}, T + 40 * MIN, undefined, T + 10 * MIN)).warmUntil, T + 90 * MIN)
  // A record that went cold, then a long turn's request: warm again.
  assert.equal(pick(lineOf(session(), {}, {}, T + 70 * MIN, undefined, T + 65 * MIN)).warmUntil, T + 125 * MIN)
})

test('a cold cache after a turn says so', () => {
  assert.deepEqual(lineOf(session(), {}, {}, T + 60 * MIN), { kind: 'expired' })
  assert.deepEqual(lineOf(session(), { cacheTtlSec: 300 }, {}, T + 6 * MIN), { kind: 'expired' })
  assert.equal(format({ kind: 'expired' }, 0), '○ cold')
})

test('nothing is shown when off or disabled', () => {
  assert.equal(lineOf(session(), { statusLine: false }, {}, T), undefined)
  assert.equal(lineOf(session(), { enabled: false }, {}, T), undefined)
  assert.equal(lineOf(session(), {}, { disabled: '1' }, T), undefined)
  assert.equal(lineOf(undefined, { statusLine: false }, {}, T), undefined)
})

test('node versions that run .ts without a flag', () => {
  for (const v of ['v22.18.0', 'v22.20.1\n', 'v23.6.0', 'v24.0.0', 'v26.3.1']) assert.equal(nodeOk(v), true, v)
  for (const v of ['v22.17.9', 'v23.5.0', 'v20.19.0', 'v18.0.0', '', 'node: not found']) assert.equal(nodeOk(v), false, v)
})

test("the line's renewal follows keeper's own rules for a muted, missed, small or spent session", () => {
  // The status line is the mod's copy of these rules; decide() is keeper's. A present human, a due ping.
  const cases: Array<Record<string, unknown>> = [
    {},
    { doneAt: T },
    { lastPingHit: false },
    { lastPingHit: true },
    { ctxTokens: 1000 },
    { pingsSoFar: THRESHOLDS.maxPings },
  ]
  for (const over of cases) {
    const s = session(over)
    const line = pick(lineOf(s, {}, {}, T))
    const verdict = decide({
      awaySeconds: 0,
      ageSec: THRESHOLDS.minAgeSec + 1,
      ctxTokens: s.ctxTokens as number,
      pingsSoFar: s.pingsSoFar as number,
      awayPingsSincePresence: 0,
      lastPingHit: (s.lastPingHit as boolean | undefined) ?? null,
      muted: s.doneAt !== undefined,
    })
    assert.equal(line.extends, verdict.ping, JSON.stringify(over))
  }
})

// --- bucket, anchor, warning window, first-turn price, resume ---

const H = 60 * MIN

test('the bucket of the record sets the end: 1 hour, 5 minutes, or the config when the record has none', () => {
  assert.equal(pick(lineOf(session({ cacheTtlSec: 3600 }), {}, {}, T)).warmUntil, T + H)
  assert.equal(pick(lineOf(session({ cacheTtlSec: 300 }), {}, {}, T)).warmUntil, T + 5 * MIN)
  assert.equal(pick(lineOf(session(), { cacheTtlSec: 300 }, {}, T)).warmUntil, T + 5 * MIN)
  assert.equal(pick(lineOf(session({ cacheTtlSec: 300 }), { cacheTtlSec: 3600 }, {}, T)).warmUntil, T + 5 * MIN, 'the record wins')
  assert.deepEqual(lineOf(session({ cacheTtlSec: 300 }), {}, {}, T + 6 * MIN), { kind: 'expired' })
})

test('no bucket anywhere reads as one hour, never five minutes', () => {
  assert.equal(pick(lineOf(session(), {}, {}, T)).warmUntil, T + H)
  assert.equal(pick(lineOf(session({ cacheTtlSec: 'x' }), { cacheTtlSec: null }, {}, T)).warmUntil, T + H)
})

test('a request seen by the mod brings its own bucket until the record catches up', () => {
  assert.equal(pick(lineOf(undefined, {}, {}, T + MIN, undefined, T, 300)).warmUntil, T + 5 * MIN)
  assert.equal(pick(lineOf(session({ cacheTtlSec: 3600 }), {}, {}, T + 11 * MIN, undefined, T + 10 * MIN, 300)).warmUntil, T + 15 * MIN)
  // An older request does not say anything about a newer record.
  assert.equal(pick(lineOf(session({ lastRequestAt: T + 20 * MIN, cacheTtlSec: 3600 }), {}, {}, T + 21 * MIN, undefined, T + 10 * MIN, 300)).warmUntil, T + 20 * MIN + H)
})

test('statusStepAnswered keeps the bucket a step wrote, and a read-only step leaves it', async () => {
  const at = Date.now()
  const $ = fakeMod({ now: at, sid: 'step-test', config: { band: false } })
  await statusRequested($ as never)
  statusStepAnswered({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 700 })
  await statusRequested($ as never)
  statusStepAnswered({ input_tokens: 1 })
  assert.equal($.shown.at(-1), `◉ ${hhmm(at + 5 * MIN)}`)
})

test('the anchor is the start of the request: lastRequestAt wins over the answer time', () => {
  const s = session({ lastTurnEndAt: T + 30_000, lastRequestAt: T })
  assert.equal(pick(lineOf(s, {}, {}, T + MIN)).warmUntil, T + H)
  // A record from before 0.7.0 has lastRequestAt equal to the turn end.
  assert.equal(pick(lineOf(session({ lastTurnEndAt: T + 30_000 }), {}, {}, T + MIN)).warmUntil, T + 30_000 + H)
})

test('a request newer than the record counts from its start', () => {
  assert.equal(pick(lineOf(session({ lastRequestAt: T }), {}, {}, T + 50 * MIN, undefined, T + 40 * MIN)).warmUntil, T + 100 * MIN)
  assert.equal(pick(lineOf(session({ lastRequestAt: T + 30 * MIN }), {}, {}, T + 40 * MIN, undefined, T + 10 * MIN)).warmUntil, T + 90 * MIN)
})

test('forks hold the cache: while forkPingsHeld is set, the answer time of the last fork is the anchor', () => {
  const s = session({ lastTurnEndAt: T + 50 * MIN, lastRequestAt: T, forkPingsHeld: 1 })
  assert.equal(pick(lineOf(s, {}, {}, T + 55 * MIN)).warmUntil, T + 50 * MIN + H)
  // A Stop resets forkPingsHeld and moves lastRequestAt: the record rules again.
  assert.equal(pick(lineOf({ ...s, forkPingsHeld: 0, lastRequestAt: T + 52 * MIN }, {}, {}, T + 55 * MIN)).warmUntil, T + 52 * MIN + H)
  assert.equal(pick(lineOf({ ...s, forkPingsHeld: 0 }, {}, {}, T + 55 * MIN)).warmUntil, T + H)
})

test('the warning window: the last 10 minutes of an hour, the last half of a 5-minute bucket (150 s)', () => {
  const warn = (s: Record<string, unknown>, now: number) => pick(lineOf(s, {}, {}, now)).warn
  assert.equal(warn(session(), T + 49 * MIN), undefined)
  assert.equal(warn(session(), T + 50 * MIN), true, 'exactly 10 minutes left')
  assert.equal(warn(session(), T + 59 * MIN), true)
  const five = session({ cacheTtlSec: 300 })
  assert.equal(warn(five, T + 149_000), undefined)
  assert.equal(warn(five, T + 150_000), true, 'exactly 150 s left')
  assert.equal(warn(five, T + 299_000), true)
})

test('the first-turn price of a new session is shown only after the cold price, and only when cheaper', () => {
  const cold = (extra: Record<string, unknown>) => lineOf(session({ coldTurnUsd: 0.98, ...extra }), {}, {}, T + H)!
  assert.deepEqual(cold({ coldStartUsd: 0.3 }), { kind: 'expired', nextColdUsd: 0.98, coldStartUsd: 0.3 })
  assert.equal(format(cold({ coldStartUsd: 0.3 }), 0), '○ cold · next $0.98 ⇄$0.30')
  assert.deepEqual(cold({ coldStartUsd: 0.98 }), { kind: 'expired', nextColdUsd: 0.98 }, 'equal: advises nothing')
  assert.deepEqual(cold({ coldStartUsd: 1.5 }), { kind: 'expired', nextColdUsd: 0.98 })
  assert.deepEqual(cold({}), { kind: 'expired', nextColdUsd: 0.98 })
  assert.deepEqual(lineOf(session({ coldStartUsd: 0.3 }), {}, {}, T + H), { kind: 'expired' }, 'no cold price: no first-turn price')
  const warm = pick(lineOf(session({ coldTurnUsd: 0.98, warmTurnUsd: 0.05, coldStartUsd: 0.3 }), {}, {}, T + MIN))
  assert.equal(format(warm, 0).includes('⇄'), false, 'warm: no ⇄')
})

test('requestStartOf (the mod) and requestStartFromLine (src) read the same table', () => {
  for (const c of REQUEST_START_CASES) {
    assert.equal(requestStartOf(c.line), c.starts ? REQUEST_START_AT : undefined, c.name)
    assert.equal(requestStartOf(c.line), requestStartFromLine(c.line), c.name)
  }
})

test('ttlOfUsage (the mod) and ttlOfUsage (src) read the same table', () => {
  for (const c of TTL_OF_USAGE_CASES) {
    assert.equal(ttlOfUsage(c.usage), c.ttlSec, c.name)
    assert.equal(ttlOfUsageSrc(c.usage), c.ttlSec, c.name)
  }
})

test('ttlOfUsage (the mod) also reads a turn.step usage', () => {
  assert.equal(ttlOfUsage({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } }), 3600)
  assert.equal(ttlOfUsage({ cache_creation: { ephemeral_5m_input_tokens: 5 } }), 300)
  assert.equal(ttlOfUsage({ ephemeral_1h_input_tokens: 5 }), 3600)
  assert.equal(ttlOfUsage({ ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 }), 300)
  for (const none of [null, undefined, 'x', {}, { input_tokens: 4 }, { cache_creation: {} }]) assert.equal(ttlOfUsage(none), undefined)
})

const ledgerLine = (t: number, over: Record<string, unknown> = {}) => JSON.stringify({ t: new Date(t).toISOString(), sessionId: SID, event: 'wake-hit', cacheRead: 90_000, cacheWrite: 0, ...over })

test('a resumed session with no record is read from its transcript: request start and bucket', () => {
  const tail = [userLine(T, 'hi'), assistantLine({ at: T + 20_000, write: 900, split: { m5: 900 } }), userLine(T + 100_000, [{ type: 'tool_result', content: 'ok' }]), assistantLine({ at: T + 110_000, read: 900 })].join('\n')
  assert.deepEqual(seedOf(tail, '', SID, T + 200_000), { lastRequestAt: T + 100_000, cacheTtlSec: 300 })
  assert.deepEqual(seedOf(userLine(T, 'x'), '', SID, T), { lastRequestAt: T })
  assert.equal(seedOf('', '', SID, T), undefined)
  assert.equal(seedOf(assistantLine({ at: T, read: 1 }), '', SID, T), undefined)
})

test('the ledger can move the anchor: a newer wake-hit of this session, not a miss, a future one, or another session', () => {
  const tail = userLine(T, 'hi')
  const seed = (ledger: string[], now = T + 70 * MIN) => seedOf(tail, ledger.join('\n'), SID, now)?.lastRequestAt
  assert.equal(seed([ledgerLine(T + 50 * MIN)]), T + 50 * MIN)
  assert.equal(seed([ledgerLine(T + 50 * MIN), ledgerLine(T + 20 * MIN)]), T + 50 * MIN, 'the newest')
  assert.equal(seed([ledgerLine(T - MIN)]), T, 'older than the request start')
  assert.equal(seed([ledgerLine(T + 50 * MIN, { event: 'wake-miss' })]), T)
  assert.equal(seed([ledgerLine(T + 50 * MIN, { cacheRead: 0, cacheWrite: 0 })]), T, 'nothing read or written')
  assert.equal(seed([ledgerLine(T + 50 * MIN, { sessionId: 'other' })]), T)
  assert.equal(seed([ledgerLine(T + 90 * MIN)], T + 70 * MIN), T, 'more than 60 s in the future')
  assert.equal(seed([ledgerLine(T + 70 * MIN + 30_000)], T + 70 * MIN), T + 70 * MIN + 30_000, 'a few seconds ahead is clock skew')
  assert.equal(seedOf('', ledgerLine(T + 50 * MIN), SID, T + 70 * MIN)?.lastRequestAt, T + 50 * MIN, 'no transcript, a hit alone')
  assert.equal(seed(['{not json "wake-hit" ' + SID, ledgerLine(T + 50 * MIN)]), T + 50 * MIN)
})

/** The engine as refresh() touches it; `files` is what $.fs serves, `shown` every status text. */
function fakeMod(o: { now: number; files?: Record<string, string>; sid?: string; config?: Record<string, unknown> }) {
  const files = { ...(o.files ?? {}) }
  if (o.config) files['/h/config.json'] = JSON.stringify(o.config)
  const shown: string[] = []
  const reads: string[] = []
  const $ = {
    shown,
    reads,
    session: { id: async () => o.sid ?? SID, info: async () => ({ transcriptPath: '/t/transcript.jsonl' }) },
    clock: { now: async () => o.now },
    env: { get: async (k: string) => (k === 'CACHE_KEEPER_HOME' ? '/h' : undefined) },
    fs: {
      stat: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT')
        return { size: Buffer.byteLength(files[p]!), kind: 'file' }
      },
      read: async (p: string, opts?: { offset?: number; length?: number }) => {
        reads.push(p)
        if (!(p in files)) throw new Error('ENOENT')
        const bytes = Buffer.from(files[p]!)
        return opts ? bytes.subarray(opts.offset ?? 0, (opts.offset ?? 0) + (opts.length ?? bytes.length)).toString() : files[p]!
      },
    },
    ui: { status: (t: string | undefined) => void shown.push(t ?? '(clear)'), invalidate: () => {} },
  }
  return $
}

test('refresh: a resumed session whose cache is still warm shows the end, not ready; one long past shows cold', async () => {
  const now = Date.now()
  const warm = fakeMod({ now, config: { band: false }, files: { '/t/transcript.jsonl': `${userLine(now - 20 * MIN, 'hi')}\n${assistantLine({ at: now - 19 * MIN, read: 5 })}\n` } })
  await refresh(warm as never)
  assert.equal(warm.shown.at(-1), `◉ ${hhmm(now - 20 * MIN + H)}`)
  const cold = fakeMod({ now, config: { band: false }, files: { '/t/transcript.jsonl': `${userLine(now - 3 * H, 'hi')}\n` } })
  await refresh(cold as never)
  assert.equal(cold.shown.at(-1), '○ cold')
  const empty = fakeMod({ now, config: { band: false }, files: { '/t/transcript.jsonl': '' } })
  await refresh(empty as never)
  assert.equal(empty.shown.at(-1), '○ ready')
})

test('refresh: a ledger hit after the last request keeps a resumed session warm, and the tails are not re-read until a file grows', async () => {
  const now = Date.now()
  const files: Record<string, string> = {
    '/t/transcript.jsonl': `${userLine(now - 70 * MIN, 'hi')}\n`,
    '/h/ledger.jsonl': `${ledgerLine(now - 10 * MIN)}\n`,
  }
  const $ = fakeMod({ now, config: { band: false }, files })
  await refresh($ as never)
  assert.equal($.shown.at(-1), `◉ ${hhmm(now - 10 * MIN + H)}`)
  const readsBefore = $.reads.length
  await refresh($ as never)
  assert.equal($.reads.filter((p) => p.endsWith('transcript.jsonl') || p.endsWith('ledger.jsonl')).length, 2, 'read once')
  assert.ok($.reads.length > readsBefore, 'config and state are read each time')
})

test('refresh: a transcript or ledger the mod cannot read leaves the line on ready, not blank', async () => {
  const $ = fakeMod({ now: Date.now(), config: { band: false } })
  await refresh($ as never)
  assert.equal($.shown.at(-1), '○ ready')
})
