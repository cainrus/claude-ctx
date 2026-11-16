import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format, lineOf, nodeOk } from '../hooks/status.ts'
import { decide, THRESHOLDS } from '../src/policy.ts'

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
