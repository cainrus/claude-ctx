/** Main-thread assistant `usage` read from a Claude Code JSONL transcript. */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export interface TurnUsage {
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  outputTokens: number
  /** input + cache read + cache write: the size of the cached prefix. */
  ctxTokens: number
  model?: string
  /** Epoch ms of the transcript entry. */
  timestamp?: number
  /** The cache bucket this turn wrote: 3600 if it wrote any 1-hour tokens, else 300; absent for a read-only turn or a transcript that does not split writes. */
  ttlSec?: 300 | 3600
}

export interface MainTurn {
  usage?: TurnUsage
  /** Epoch ms the last model request started. */
  requestStart?: number
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** The bucket a usage object wrote: 3600 if any 1-hour tokens, else 300 if any 5-minute ones, else undefined. */
// INVARIANT: hooks/status.ts `ttlOfUsage` is the mod's copy of this rule (it also reads the flat form of a `turn.step` usage); keep the two in step (test/status.test.ts runs one table on both).
export function ttlOfUsage(u: any): 300 | 3600 | undefined {
  const split = u?.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {}
  if (n(split.ephemeral_1h_input_tokens) > 0) return 3600
  if (n(split.ephemeral_5m_input_tokens) > 0) return 300
  return undefined
}

/** Undefined unless the line is a main-thread assistant turn with usage. */
export function usageFromLine(line: string): TurnUsage | undefined {
  if (!line.includes('"usage"')) return undefined
  let rec: any
  try {
    rec = JSON.parse(line)
  } catch {
    return undefined
  }
  // INVARIANT: sidechain (subagent) and synthetic entries are skipped: their usage is not the main thread's cache.
  if (!rec || rec.type !== 'assistant' || rec.isSidechain === true || rec.isApiErrorMessage === true) return undefined
  const msg = rec.message
  const u = msg?.usage
  if (!u || typeof u !== 'object') return undefined
  if (msg.model === '<synthetic>') return undefined

  const inputTokens = n(u.input_tokens)
  const cacheRead = n(u.cache_read_input_tokens)
  const cacheWrite = n(u.cache_creation_input_tokens)
  // WORKAROUND: an error turn under another name has all-zero usage; reading it would zero the context.
  if (inputTokens + cacheRead + cacheWrite === 0) return undefined
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
  const ttlSec = ttlOfUsage(u)
  return {
    inputTokens,
    cacheRead,
    cacheWrite,
    outputTokens: n(u.output_tokens),
    ctxTokens: inputTokens + cacheRead + cacheWrite,
    ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
    ...(Number.isFinite(ts) ? { timestamp: ts } : {}),
    ...(ttlSec !== undefined ? { ttlSec } : {}),
  }
}

/** Lines the client writes itself: they send no request. */
const LOCAL_ONLY = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/

function promptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
  return ''
}

/** Epoch ms of a main-thread `user` entry that a model request follows; undefined for any other line. */
// INVARIANT: hooks/status.ts `requestStartOf` is the mod's copy of this rule; keep the two in step (test/status.test.ts runs one table on both).
export function requestStartFromLine(line: string): number | undefined {
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

function scanLinesBackwards(transcriptPath: string, initialChunk: number, visit: (line: string) => boolean): void {
  let fd: number
  try {
    fd = openSync(transcriptPath, 'r')
  } catch {
    return
  }
  try {
    let end = fstatSync(fd).size
    let chunk = Math.max(1024, initialChunk)
    for (;;) {
      const start = Math.max(0, end - chunk)
      const buf = Buffer.alloc(end - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n')
      const from = start === 0 ? 0 : 1
      for (let i = lines.length - 1; i >= from; i--) {
        if (visit(lines[i])) return
      }
      if (start === 0) return
      const firstBreak = buf.indexOf(0x0a)
      end = start + (firstBreak < 0 ? buf.length : firstBreak)
      chunk *= 4
    }
  } catch {
    return
  } finally {
    closeSync(fd)
  }
}

function scanBackwards(transcriptPath: string, initialChunk: number, visit: (u: TurnUsage) => boolean): void {
  scanLinesBackwards(transcriptPath, initialChunk, (line) => {
    const u = usageFromLine(line)
    return u !== undefined && visit(u)
  })
}

/** The last main-thread usage and when the last request started, in one backward pass: the cache lifetime counts from the start, not from the answer. */
export function lastMainTurn(transcriptPath: string, initialChunk = 256 * 1024): MainTurn {
  const turn: MainTurn = {}
  scanLinesBackwards(transcriptPath, initialChunk, (line) => {
    turn.usage ??= usageFromLine(line)
    turn.requestStart ??= requestStartFromLine(line)
    return turn.usage !== undefined && turn.requestStart !== undefined
  })
  return turn
}

/** The session's first main-thread request, read from the front: the size of a start with nothing but the system prompt. */
export function firstMainUsage(transcriptPath: string, chunk = 64 * 1024): TurnUsage | undefined {
  let fd: number
  try {
    fd = openSync(transcriptPath, 'r')
  } catch {
    return undefined
  }
  try {
    const buf = Buffer.alloc(chunk)
    let carry = Buffer.alloc(0)
    for (;;) {
      const got = readSync(fd, buf, 0, chunk, null)
      if (got === 0) return usageFromLine(carry.toString('utf8'))
      // WARNING: decode only whole lines: a chunk edge can cut a multi-byte character, so bytes are carried, not text.
      const bytes = Buffer.concat([carry, buf.subarray(0, got)])
      const lastBreak = bytes.lastIndexOf(0x0a)
      if (lastBreak < 0) {
        carry = bytes
        continue
      }
      for (const line of bytes.subarray(0, lastBreak).toString('utf8').split('\n')) {
        const u = usageFromLine(line)
        if (u) return u
      }
      carry = bytes.subarray(lastBreak + 1)
    }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

export function lastMainUsage(transcriptPath: string, initialChunk = 256 * 1024): TurnUsage | undefined {
  let last: TurnUsage | undefined
  scanBackwards(transcriptPath, initialChunk, (u) => {
    last = u
    return true
  })
  return last
}

/** The first main-thread request at or after `sinceMs`: what a resumed turn paid for the held prefix. */
// WARNING: the first, not the last: when the first request rewrote the context, every later one reads that
// fresh write and looks like a hit.
export function firstMainUsageSince(transcriptPath: string, sinceMs: number, initialChunk = 256 * 1024): TurnUsage | undefined {
  let first: TurnUsage | undefined
  scanBackwards(transcriptPath, initialChunk, (u) => {
    if (u.timestamp === undefined) return false
    if (u.timestamp < sinceMs) return true
    first = u
    return false
  })
  return first
}
