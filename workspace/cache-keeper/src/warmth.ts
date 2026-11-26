/**
 * Is a session's prompt cache warm, until when, and when did a person last prompt there: the one answer keeper's
 * own stops read and outside tools get from `cache-keeper status --json <session>`. Warm counts from the start of
 * the last request that renewed the cache, in the bucket it wrote (5 min or 1 h), less a safety margin, and never
 * longer than 55 min after the last touch; a record that cannot say falls back to that 55 min line. A fork ping
 * counts (its ledger `wake-hit` outlives the session record); a refused request does not.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { ledgerPath } from './ledger.ts'
import { personPath, readJson, safeId, sessionPath } from './state.ts'
import { scanLinesBackwards } from './transcript.ts'

/** The line a record without anchor and bucket is judged by: well inside the 1 h TTL, as calling a warm session cold only costs a question. */
export const WARM_MAX_S = 55 * 60

/** How far ahead of the clock a mark may be and still count; further is a broken record, which would read warm for as long. */
export const FUTURE_SKEW_MS = 60_000

/** How far a transcript touch may run past the record's lastTurnEndAt and still be the turn the record saw. */
export const ANCHOR_SLACK_MS = 120_000

export type CacheTtlSec = 300 | 3600

/** What keeper's files say of a session's cache, each field plausible or absent. */
export interface KeeperMarks {
  /** The newer of the record's lastTurnEndAt and the session's last ledger `wake-hit`. */
  lastTurnEndAt?: number
  cacheAnchorAt?: number
  cacheTtlSec?: CacheTtlSec
}

export interface Warmth {
  warm: boolean
  /** Known to have gone cold: a touch is on record and the cache outlived it. Nothing on record is neither warm nor cold. */
  cold: boolean
  /** Epoch ms the cache was last known alive; absent when nothing ever touched it. */
  lastWarmAt?: number
  /** Epoch ms it is to be called cold at; absent with lastWarmAt. */
  coldAt?: number
  /** The bucket coldAt was counted in; absent when the fixed line decided. */
  ttlSec?: CacheTtlSec
}

/** `persons/<id>.json`, each field plausible or absent. */
export interface Presence {
  promptAt: number
  personAt?: number
  personCommand?: string
  personEnteredAt?: number
  personEnteredCommand?: string
}

export function plausibleMark(m: unknown, now: number): m is number {
  return typeof m === 'number' && Number.isFinite(m) && m > 0 && m <= now + FUTURE_SKEW_MS
}

function isCacheTtl(v: unknown): v is CacheTtlSec {
  return v === 300 || v === 3600
}

// INVARIANT: a reader takes ids from outside (a hook payload, a CLI argument): only an id the writers' safeId leaves as it is reaches a path or the ledger match.
function isToken(sessionId: string): boolean {
  return sessionId !== '' && safeId(sessionId) === sessionId
}

export function nativeSafetyMs(ttlSec: CacheTtlSec): number {
  return ttlSec === 3600 ? 5 * 60_000 : 30_000
}

/** ms epoch the cache was last known alive: the newer of the transcript touch and keeper's mark. */
export function lastWarmAt(transcriptTouchAt: number | undefined, marks: KeeperMarks | undefined, now: number): number | undefined {
  const all = [transcriptTouchAt, marks?.lastTurnEndAt].filter((m): m is number => plausibleMark(m, now))
  return all.length === 0 ? undefined : Math.max(...all)
}

/**
 * ms epoch the cache is to be called cold at by the record's own clock: anchor + bucket - safety, or, when the
 * transcript saw a newer turn than the record (an older plugin, keeper off), the newest mark + bucket - safety.
 * Undefined without a bucket or a mark. Never later than the WARM_MAX_S line: the native rule only makes cold earlier.
 */
export function nativeColdAt(
  transcriptTouchAt: number | undefined,
  marks: KeeperMarks | undefined,
  now: number,
  newest: number | undefined = lastWarmAt(transcriptTouchAt, marks, now),
): number | undefined {
  const ttl = marks?.cacheTtlSec
  if (newest === undefined || !isCacheTtl(ttl)) return undefined
  const anchor = marks?.cacheAnchorAt
  const lastEnd = marks?.lastTurnEndAt
  const current = lastEnd !== undefined && (transcriptTouchAt === undefined || transcriptTouchAt <= lastEnd + ANCHOR_SLACK_MS)
  const clockStart = plausibleMark(anchor, now) && current ? anchor : newest
  return Math.min(clockStart + ttl * 1000 - nativeSafetyMs(ttl), newest + WARM_MAX_S * 1000)
}

/**
 * The verdict from marks already read. No mark at all is cold: an unknown is never woken. `fallbackTtlSec` (the
 * config's `cacheTtlSec`) stands in for a bucket the record never learned: a bucket the server has counts from
 * the anchor, any other TTL from the last touch, less a margin; never past the 55 min line either way.
 */
export function warmthOf(transcriptTouchAt: number | undefined, marks: KeeperMarks | undefined, now: number, fallbackTtlSec?: number): Warmth {
  const newest = lastWarmAt(transcriptTouchAt, marks, now)
  if (newest === undefined) return { warm: false, cold: false }
  const learned = marks?.cacheTtlSec !== undefined
  if (!learned && isCacheTtl(fallbackTtlSec)) marks = { ...marks, cacheTtlSec: fallbackTtlSec }
  const native = nativeColdAt(transcriptTouchAt, marks, now, newest)
  const odd = !learned && native === undefined && typeof fallbackTtlSec === 'number' && Number.isFinite(fallbackTtlSec) && fallbackTtlSec >= 0
  const line = newest + WARM_MAX_S * 1000
  const coldAt = native ?? (odd ? Math.min(line, newest + fallbackTtlSec * 1000 - Math.min(30_000, fallbackTtlSec * 100)) : line)
  return { warm: now < coldAt, cold: now >= coldAt, lastWarmAt: newest, coldAt, ...(native !== undefined ? { ttlSec: marks!.cacheTtlSec } : {}) }
}

/** The record's marks and the ledger's last `wake-hit` (the record dies at SessionEnd, the ledger does not). */
export function readKeeperMarks(home: string, sessionId: string, now: number): KeeperMarks | undefined {
  if (!isToken(sessionId)) return undefined
  const record = readJson<Record<string, unknown>>(sessionPath(home, sessionId))
  const rec = record && typeof record === 'object' ? record : undefined
  const ends = [rec?.lastTurnEndAt, ledgerWakeHitAt(home, sessionId, now)].filter((m): m is number => plausibleMark(m, now))
  const marks: KeeperMarks = {}
  if (ends.length > 0) marks.lastTurnEndAt = Math.max(...ends)
  if (plausibleMark(rec?.cacheAnchorAt, now)) marks.cacheAnchorAt = rec.cacheAnchorAt as number
  if (isCacheTtl(rec?.cacheTtlSec)) marks.cacheTtlSec = rec.cacheTtlSec
  return Object.keys(marks).length === 0 ? undefined : marks
}

/** How much of the ledger's end is scanned: a session's last ping is near the end, and the file only grows. */
export const LEDGER_TAIL_BYTES = 256 * 1024

/** ms epoch of the session's newest `wake-hit` that read or wrote the cache; a `ping` alone is stamped when sent, refused or not. */
export function ledgerWakeHitAt(home: string, sessionId: string, now: number): number | undefined {
  if (!isToken(sessionId)) return undefined
  const tail = readTail(ledgerPath(home), LEDGER_TAIL_BYTES)
  if (tail === undefined) return undefined
  let newest: number | undefined
  for (const line of tail.split('\n')) {
    if (!line.includes('"wake-hit"')) continue
    let e: { t?: unknown; sessionId?: unknown; event?: unknown; cacheRead?: unknown; cacheWrite?: unknown }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.sessionId !== sessionId || e.event !== 'wake-hit') continue
    if ((Number(e.cacheRead) || 0) + (Number(e.cacheWrite) || 0) <= 0) continue
    const at = typeof e.t === 'string' ? Date.parse(e.t) : Number.NaN
    if (plausibleMark(at, now) && (newest === undefined || at > newest)) newest = at
  }
  return newest
}

function readTail(path: string, bytes: number): string | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    const got = readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8', 0, got)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

type TranscriptEntry = {
  type?: string
  isSidechain?: boolean
  isApiErrorMessage?: boolean
  timestamp?: string
  message?: { model?: string; usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null }
}

/** Did this assistant entry come from a request that reached the model and read or wrote the cache? */
export function touchedCache(e: TranscriptEntry): boolean {
  // WARNING: Claude Code writes a synthetic entry (model "<synthetic>", isApiErrorMessage) with zero usage for a refused request, a rate limit say: no touch.
  if (e.isApiErrorMessage === true || e.message?.model === '<synthetic>') return false
  const u = e.message?.usage
  // INVARIANT: no usage is no request: the mod's gate answers a turn itself with `usage: null`, and as a touch it read a cold session warm for 55 min.
  if (u === undefined || u === null) return false
  return (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) > 0
}

function touchOfLine(line: string, now: number): number | undefined {
  if (!line.includes('"assistant"')) return undefined
  let e: TranscriptEntry
  try {
    e = JSON.parse(line)
  } catch {
    return undefined
  }
  // INVARIANT: a subagent's entry (isSidechain) renews its own cache, not the main thread's (as src/transcript.ts skips it).
  if (e.type !== 'assistant' || e.isSidechain === true || !touchedCache(e)) return undefined
  const at = e.timestamp === undefined ? Number.NaN : Date.parse(e.timestamp)
  return plausibleMark(at, now) ? at : undefined
}

/** ms epoch of the newest assistant entry that touched the cache, from the file's end; an attach's metadata lines are no touch. */
export function transcriptTouchAt(transcriptPath: string, now: number): number | undefined {
  let found: number | undefined
  scanLinesBackwards(transcriptPath, 256 * 1024, (line) => {
    found = touchOfLine(line, now)
    return found !== undefined
  })
  return found
}

/** The whole answer for one session; `transcriptPath` adds the turns keeper's record may not have seen. */
export function readWarmth(home: string, sessionId: string, now: number, transcriptPath?: string, fallbackTtlSec?: number): Warmth {
  const touch = transcriptPath ? transcriptTouchAt(transcriptPath, now) : undefined
  return warmthOf(touch, readKeeperMarks(home, sessionId, now), now, fallbackTtlSec)
}

/** What `cache-keeper status --json` prints: the warmth flat, presence nested; absent fields are unknown. */
export interface SessionStatus extends Warmth {
  sessionId: string
  now: number
  presence?: Presence
}

export function sessionStatus(home: string, sessionId: string, now: number, transcriptPath?: string, fallbackTtlSec?: number): SessionStatus {
  const presence = readPresence(home, sessionId, now)
  return { sessionId, now, ...readWarmth(home, sessionId, now, transcriptPath, fallbackTtlSec), ...(presence ? { presence } : {}) }
}

export function readPresence(home: string, sessionId: string, now: number): Presence | undefined {
  if (!isToken(sessionId)) return undefined
  const raw = readJson<Record<string, unknown>>(personPath(home, sessionId))
  if (!raw || typeof raw !== 'object' || !plausibleMark(raw.promptAt, now)) return undefined
  const p: Presence = { promptAt: raw.promptAt }
  if (plausibleMark(raw.personAt, now)) p.personAt = raw.personAt
  if (typeof raw.personCommand === 'string' && raw.personCommand !== '') p.personCommand = raw.personCommand
  if (plausibleMark(raw.personEnteredAt, now)) p.personEnteredAt = raw.personEnteredAt
  if (typeof raw.personEnteredCommand === 'string' && raw.personEnteredCommand !== '') p.personEnteredCommand = raw.personEnteredCommand
  return p
}
