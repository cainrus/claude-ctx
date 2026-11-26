import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WARM_MAX_S,
  lastWarmAt,
  ledgerWakeHitAt,
  nativeColdAt,
  readKeeperMarks,
  readPresence,
  readWarmth,
  transcriptTouchAt,
  warmthOf,
  type KeeperMarks,
} from '../src/warmth.ts'
import { tempHome } from './helpers.ts'

const NOW = Date.parse('2026-11-16T12:00:00Z')
const MIN = 60_000
const SID = '63594326-5559-449b'
const warm = (touch: number | undefined, marks: KeeperMarks | undefined, now = NOW) => warmthOf(touch, marks, now).warm

function homeWith(ledger: unknown[] = [], raw = ''): string {
  const home = tempHome()
  mkdirSync(join(home, 'sessions'))
  writeFileSync(join(home, 'ledger.jsonl'), raw + ledger.map((l) => `${JSON.stringify(l)}\n`).join(''))
  return home
}

const writeRecord = (home: string, record: unknown) => writeFileSync(join(home, 'sessions', `${SID}.json`), typeof record === 'string' ? record : JSON.stringify(record))

const hit = (at: number, extra: Record<string, unknown> = {}) => ({
  t: new Date(at).toISOString(),
  sessionId: SID,
  event: 'wake-hit',
  transport: 'fork',
  cacheRead: 215798,
  cacheWrite: 0,
  ...extra,
})

test('lastWarmAt: the newer of the two marks; none, junk or a far-future mark is no mark', () => {
  assert.equal(lastWarmAt(NOW - 70 * MIN, { lastTurnEndAt: NOW - 20 * MIN }, NOW), NOW - 20 * MIN)
  assert.equal(lastWarmAt(NOW - 10 * MIN, { lastTurnEndAt: NOW - 20 * MIN }, NOW), NOW - 10 * MIN)
  assert.equal(lastWarmAt(undefined, undefined, NOW), undefined)
  assert.equal(lastWarmAt(Number.NaN, { lastTurnEndAt: Number.POSITIVE_INFINITY }, NOW), undefined)
  assert.equal(lastWarmAt(NOW - 80 * MIN, { lastTurnEndAt: NOW + 24 * 60 * MIN }, NOW), NOW - 80 * MIN)
  assert.equal(lastWarmAt(NOW - 80 * MIN, { lastTurnEndAt: NOW + 30_000 }, NOW), NOW + 30_000, 'a few seconds of skew still count')
})

test('readKeeperMarks: reads sessions/<id>.json; lastPingAt is no touch; a non-token id never reaches a path', () => {
  const home = homeWith()
  writeRecord(home, { lastTurnEndAt: NOW, lastPingAt: NOW + 5 })
  writeFileSync(join(home, 'leak.json'), JSON.stringify({ lastTurnEndAt: NOW }))
  assert.deepEqual(readKeeperMarks(home, SID, NOW), { lastTurnEndAt: NOW })
  assert.equal(readKeeperMarks(home, 'missing', NOW), undefined)
  assert.equal(readKeeperMarks(home, '../leak', NOW), undefined)
})

test('ledgerWakeHitAt: the newest confirmed ping of THIS session, nothing else', () => {
  const home = homeWith([
    hit(NOW - 50 * MIN),
    hit(NOW - 5 * MIN),
    hit(NOW - 1 * MIN, { sessionId: 'someone-else' }),
    { ...hit(NOW - 2 * MIN), event: 'ping' },
    hit(NOW - 3 * MIN, { cacheRead: 0, cacheWrite: 0 }),
    { ...hit(NOW - 4 * MIN), event: 'wake-miss' },
  ])
  assert.equal(ledgerWakeHitAt(home, SID, NOW), NOW - 5 * MIN)
  assert.equal(ledgerWakeHitAt(home, 'absent', NOW), undefined)
  assert.equal(ledgerWakeHitAt(home, '../leak', NOW), undefined)
  assert.equal(ledgerWakeHitAt(join(home, 'no-such-dir'), SID, NOW), undefined)
})

test('ledgerWakeHitAt: a future or unparsable stamp is junk; a torn line is skipped', () => {
  const home = homeWith([hit(NOW + 24 * 60 * MIN), { ...hit(NOW), t: 'yesterday-ish' }, hit(NOW - 9 * MIN)], '{"event":"wake-hit","sess\n')
  assert.equal(ledgerWakeHitAt(home, SID, NOW), NOW - 9 * MIN)
})

test('ledgerWakeHitAt: reads the END of a big ledger, not its head', () => {
  const filler = Array.from({ length: 4000 }, (_, i) => ({ t: new Date(NOW - 99 * MIN).toISOString(), sessionId: `s${i}`, event: 'skip', note: 'x'.repeat(80) }))
  assert.equal(ledgerWakeHitAt(homeWith([...filler, hit(NOW - 7 * MIN)]), SID, NOW), NOW - 7 * MIN)
  assert.equal(ledgerWakeHitAt(homeWith([hit(NOW - 7 * MIN), ...filler]), SID, NOW), undefined, 'a hit pushed out of the tail is no evidence')
})

test('readKeeperMarks: with the record gone (SessionEnd) the ledger carries the mark; the newer of the two wins', () => {
  const home = homeWith([hit(NOW - 5 * MIN)])
  assert.deepEqual(readKeeperMarks(home, SID, NOW), { lastTurnEndAt: NOW - 5 * MIN })
  writeRecord(home, { lastTurnEndAt: NOW - 2 * MIN })
  assert.deepEqual(readKeeperMarks(home, SID, NOW), { lastTurnEndAt: NOW - 2 * MIN })
  writeRecord(home, { lastTurnEndAt: NOW + 24 * 60 * MIN })
  assert.deepEqual(readKeeperMarks(home, SID, NOW), { lastTurnEndAt: NOW - 5 * MIN }, 'a future record mark is dropped')
  writeRecord(home, '{not json')
  assert.deepEqual(readKeeperMarks(home, SID, NOW), { lastTurnEndAt: NOW - 5 * MIN })
  assert.equal(readKeeperMarks(home, SID, NOW - 10 * MIN), undefined, 'a hit ahead of the caller clock is a future mark')
})

test('readKeeperMarks: carries the anchor and the bucket; junk in either is dropped', () => {
  const home = homeWith()
  writeRecord(home, { lastTurnEndAt: NOW - 2 * MIN, cacheAnchorAt: NOW - 3 * MIN, cacheTtlSec: 300 })
  assert.deepEqual(readKeeperMarks(home, SID, NOW), { lastTurnEndAt: NOW - 2 * MIN, cacheAnchorAt: NOW - 3 * MIN, cacheTtlSec: 300 })
  writeRecord(home, { lastTurnEndAt: NOW - 2 * MIN, cacheAnchorAt: NOW + 24 * 60 * MIN, cacheTtlSec: 600 })
  assert.deepEqual(readKeeperMarks(home, SID, NOW), { lastTurnEndAt: NOW - 2 * MIN })
})

test('warmthOf: a record without anchor and bucket is the 55 min line', () => {
  for (const ago of [0, 10, 54, 55, 56, 120]) {
    for (const marks of [undefined, { lastTurnEndAt: NOW - ago * MIN }]) {
      const at = lastWarmAt(NOW - (ago + 1) * MIN, marks, NOW)
      assert.equal(warm(NOW - (ago + 1) * MIN, marks), at !== undefined && NOW - at < WARM_MAX_S * 1000, `ago ${ago}`)
    }
  }
  assert.deepEqual(warmthOf(undefined, undefined, NOW), { warm: false, cold: false }, 'no mark: neither warm nor known cold')
  assert.deepEqual(warmthOf(NOW - 10 * MIN, undefined, NOW), { warm: true, cold: false, lastWarmAt: NOW - 10 * MIN, coldAt: NOW + 45 * MIN })
  assert.equal(warmthOf(NOW - 56 * MIN, undefined, NOW).cold, true)
})

test('warmthOf: a 5 min bucket goes cold after ~4.5 min, where the line says warm', () => {
  const marks = (agoMs: number) => ({ lastTurnEndAt: NOW - agoMs + 20_000, cacheAnchorAt: NOW - agoMs, cacheTtlSec: 300 as const })
  assert.equal(warm(NOW - 4 * MIN, marks(4 * MIN)), true)
  assert.equal(warm(NOW - 4.5 * MIN + 20_000, marks(4.5 * MIN)), false, 'anchor + 300 s - 30 s')
  assert.equal(warm(NOW - 10 * MIN, { lastTurnEndAt: NOW - 10 * MIN + 20_000 }), true, 'the line calls it warm')
  assert.deepEqual(warmthOf(undefined, marks(4 * MIN), NOW), { warm: true, cold: false, lastWarmAt: NOW - 4 * MIN + 20_000, coldAt: NOW - 4 * MIN + 270_000, ttlSec: 300 })
})

test('warmthOf: a 1 h bucket matches the 55 min line', () => {
  const marks = (agoMin: number) => ({ cacheAnchorAt: NOW - agoMin * MIN, cacheTtlSec: 3600 as const })
  assert.equal(warm(NOW - 54 * MIN, marks(54)), true)
  assert.equal(warm(NOW - 55 * MIN, marks(55)), false)
  assert.equal(nativeColdAt(NOW, marks(0), NOW), NOW + WARM_MAX_S * 1000)
})

test('nativeColdAt: a turn newer than the anchor (the record missed it) counts the bucket from that turn', () => {
  const stale = { cacheAnchorAt: NOW - 30 * MIN, cacheTtlSec: 300 as const }
  assert.equal(nativeColdAt(NOW - 2 * MIN, stale, NOW), NOW - 2 * MIN + 270_000)
  const live = { cacheAnchorAt: NOW - 10 * MIN, cacheTtlSec: 300 as const, lastTurnEndAt: NOW - 10 * MIN + 90_000 }
  assert.equal(nativeColdAt(NOW - 10 * MIN + 90_000, live, NOW), NOW - 10 * MIN + 270_000, 'within the slack: the anchor stands')
  assert.equal(nativeColdAt(NOW - 2 * MIN, { ...live, lastTurnEndAt: NOW - 10 * MIN }, NOW), NOW - 2 * MIN + 270_000)
  assert.equal(nativeColdAt(NOW - 2 * MIN, { cacheAnchorAt: NOW - 3 * MIN, cacheTtlSec: 300 }, NOW), NOW - 2 * MIN + 270_000, 'no lastTurnEndAt: no vouching')
})

test('nativeColdAt: a long generation - the record saw the turn, so its anchor (turn start) stands', () => {
  const T = NOW - 10 * MIN
  const marks = { cacheAnchorAt: T, cacheTtlSec: 300 as const, lastTurnEndAt: T + 4 * MIN }
  assert.equal(nativeColdAt(T + 4 * MIN, marks, NOW), T + 4.5 * MIN)
  assert.equal(warm(T + 4 * MIN, marks, T + 4.25 * MIN), true)
  assert.equal(warm(T + 4 * MIN, marks, T + 4.5 * MIN), false)
})

test('nativeColdAt: undefined for an unknown bucket or no mark at all', () => {
  assert.equal(nativeColdAt(undefined, { lastTurnEndAt: NOW, cacheAnchorAt: NOW }, NOW), undefined)
  assert.equal(nativeColdAt(undefined, { cacheAnchorAt: NOW - MIN, cacheTtlSec: 3600 }, NOW), undefined)
  assert.equal(warm(undefined, { cacheAnchorAt: NOW - MIN, cacheTtlSec: 3600 }), false)
})

test('invariant: the native verdict is never warm where the 55 min line says cold', () => {
  const marks: (number | undefined)[] = [undefined, NOW - 120 * MIN, NOW - 56 * MIN, NOW - 55 * MIN, NOW - 30 * MIN, NOW - 6 * MIN, NOW - 2 * MIN, NOW]
  const anchors: (number | undefined)[] = [undefined, NOW - 200 * MIN, NOW - 60 * MIN, NOW - 30 * MIN, NOW - 6 * MIN, NOW - MIN, NOW, NOW + 30_000]
  const ttls: (CacheTtl | undefined)[] = [undefined, 300, 3600]
  const nows = [NOW, NOW + 3 * MIN, NOW + 50 * MIN, NOW + 54 * MIN, NOW + 56 * MIN, NOW + 3 * 60 * MIN]
  let checked = 0
  for (const touch of marks) for (const turnEnd of marks) for (const anchor of anchors) for (const ttl of ttls) for (const now of nows) {
    const k: KeeperMarks = {}
    if (turnEnd !== undefined) k.lastTurnEndAt = turnEnd
    if (anchor !== undefined) k.cacheAnchorAt = anchor
    if (ttl !== undefined) k.cacheTtlSec = ttl
    const at = lastWarmAt(touch, k, now)
    const line = at !== undefined && now - at < WARM_MAX_S * 1000
    if (warm(touch, k, now)) assert.equal(line, true, JSON.stringify({ touch, k, now }))
    checked++
  }
  assert.ok(checked > 9000)
})

type CacheTtl = 300 | 3600

const assistant = (at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { model: 'claude-opus-5-5', usage: { cache_read_input_tokens: 1000 } }, ...extra })

test('transcriptTouchAt: the newest assistant entry that touched the cache; a refusal, a title line or a torn line is none', () => {
  const home = tempHome()
  const path = join(home, 't.jsonl')
  writeFileSync(path, [
    assistant(NOW - 30 * MIN),
    assistant(NOW - 20 * MIN),
    assistant(NOW - 10 * MIN, { isApiErrorMessage: true, message: { model: '<synthetic>', usage: { cache_read_input_tokens: 0 } } }),
    JSON.stringify({ type: 'ai-title', timestamp: new Date(NOW).toISOString() }),
    assistant(NOW + 24 * 60 * MIN),
    '{"type":"assistant","timest',
  ].join('\n'))
  assert.equal(transcriptTouchAt(path, NOW), NOW - 20 * MIN)
  assert.equal(transcriptTouchAt(join(home, 'none.jsonl'), NOW), undefined)
})

test('transcriptTouchAt: an entry with no usage (a turn the gate answered itself) is no request', () => {
  const path = join(tempHome(), 't.jsonl')
  writeFileSync(path, [assistant(NOW - 70 * MIN), assistant(NOW - MIN, { message: { model: 'claude-opus-5-5', usage: null } }), JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(), message: {} })].join('\n'))
  assert.equal(transcriptTouchAt(path, NOW), NOW - 70 * MIN)
})

test('readKeeperMarks / readPresence: an id the writers keep as it is (a dot inside) is read; one they would flatten is not', () => {
  const home = homeWith()
  writeFileSync(join(home, 'sessions', 'abc.def.json'), JSON.stringify({ lastTurnEndAt: NOW }))
  assert.deepEqual(readKeeperMarks(home, 'abc.def', NOW), { lastTurnEndAt: NOW })
  assert.equal(readKeeperMarks(home, '.hidden', NOW), undefined)
  assert.equal(readKeeperMarks(home, '', NOW), undefined)
})

test('transcriptTouchAt: a subagent\'s entry renews its own cache, not the main thread\'s', () => {
  const path = join(tempHome(), 't.jsonl')
  writeFileSync(path, [assistant(NOW - 70 * MIN), assistant(NOW - MIN, { isSidechain: true })].join('\n'))
  assert.equal(transcriptTouchAt(path, NOW), NOW - 70 * MIN)
})

test('warmthOf: a fallback bucket stands in only for one the record never learned', () => {
  assert.equal(warmthOf(NOW - 10 * MIN, undefined, NOW, 300).warm, false, '5 min from the config: cold after ~4.5 min')
  assert.equal(warmthOf(NOW - 10 * MIN, undefined, NOW).warm, true, 'no fallback: the 55 min line')
  assert.equal(warmthOf(NOW - 10 * MIN, { cacheTtlSec: 3600, lastTurnEndAt: NOW - 10 * MIN }, NOW, 300).warm, true, 'a learned bucket wins')
  assert.equal(warmthOf(NOW - 10 * MIN, undefined, NOW, 1800).warm, true, 'a custom 30 min TTL: warm at 10 min')
  assert.equal(warmthOf(NOW - 31 * MIN, undefined, NOW, 1800).warm, false, '... cold at 31')
  assert.equal(warmthOf(NOW - 10 * MIN, undefined, NOW, 7200).warm, true)
  assert.equal(warmthOf(NOW - 56 * MIN, undefined, NOW, 7200).warm, false, 'never past the 55 min line')
  assert.equal(warmthOf(NOW, undefined, NOW, 0).warm, false, '0: cold at once')
})

test('readWarmth: record, ledger and transcript together', () => {
  const home = homeWith([hit(NOW - 40 * MIN)])
  const path = join(home, 't.jsonl')
  writeFileSync(path, assistant(NOW - 3 * MIN))
  assert.equal(readWarmth(home, SID, NOW).coldAt, NOW + 15 * MIN, 'the ledger alone: 55 min from the hit')
  assert.equal(readWarmth(home, SID, NOW, path).coldAt, NOW + 52 * MIN, 'a newer transcript turn wins')
})

test('readPresence: persons/<id>.json, each field plausible or dropped', () => {
  const home = homeWith()
  mkdirSync(join(home, 'persons'))
  const write = (r: object) => writeFileSync(join(home, 'persons', `${SID}.json`), JSON.stringify(r))
  assert.equal(readPresence(home, SID, NOW), undefined)
  write({ personAt: NOW - MIN })
  assert.equal(readPresence(home, SID, NOW), undefined, 'no promptAt')
  write({ promptAt: NOW - MIN, personAt: NOW - 2 * MIN, personCommand: 'handoff', personEnteredAt: NOW - 3 * MIN, personEnteredCommand: 'x' })
  assert.deepEqual(readPresence(home, SID, NOW), { promptAt: NOW - MIN, personAt: NOW - 2 * MIN, personCommand: 'handoff', personEnteredAt: NOW - 3 * MIN, personEnteredCommand: 'x' })
  write({ promptAt: NOW - MIN, personAt: NOW + 24 * 60 * MIN, personEnteredAt: 'soon' })
  assert.deepEqual(readPresence(home, SID, NOW), { promptAt: NOW - MIN })
  write({ promptAt: NOW + 24 * 60 * MIN })
  assert.equal(readPresence(home, SID, NOW), undefined)
  assert.equal(readPresence(home, '../leak', NOW), undefined)
})
