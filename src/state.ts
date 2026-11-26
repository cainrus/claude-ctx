/** On-disk state under `$CACHE_KEEPER_HOME`: `sessions/`, `forks/`, `away-budget.json`. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Config } from './config.ts'

export interface SessionState {
  sessionId: string
  transcriptPath?: string
  /** Epoch ms the cache was last touched by a finished turn (real or wake). */
  lastTurnEndAt?: number
  /** Epoch ms of the last real (non-wake) prompt. */
  lastHumanAt?: number
  lastPingAt?: number
  ctxTokens: number
  model?: string
  pingsSoFar: number
  /** A wake was sent and its closing Stop has not been recorded yet. */
  pendingPing: boolean
  lastPingHit: boolean | null
  /** USD this session's pings cost so far, as the report prices them. */
  pingCostUsd?: number
  /** USD the next turn's prompt costs from a warm cache, and written into a cold one; set at each turn end. */
  warmTurnUsd?: number
  coldTurnUsd?: number
  /** Prompt tokens of the session's first main request (0 = none found); read once, so a transcript is not rescanned every Stop. */
  coldStartTokens?: number
  /** USD the first turn of a NEW session would cost here: `coldStartTokens` written into a 1-hour cache, at the current model's price; set at each turn end. */
  coldStartUsd?: number
  /** The cache bucket of the last turn that wrote one, seconds (300 or 3600); a read-only turn keeps the previous one. */
  cacheTtlSec?: number
  /** Reset by a real prompt. */
  handoffRequested?: boolean
  /** The open wake is a handoff: its closing Stop checks the brief. */
  handoffPending?: boolean
  /** Epoch ms the gate answered a turn itself instead of the model. */
  gateTurnAt?: number
  /** Epoch ms of the real prompt that ended a pinged stretch; the next Stop logs `resume-paid` and clears it. */
  resumeAt?: number
  /** Epoch ms of `/cache-keeper:done`. */
  doneAt?: number
  /** A fork is scored by `forked`, a turn by `record`. */
  pingTransport?: 'fork' | 'turn'
  /** Forks re-sent for the open ping after one came back with no reply. */
  forkRetries?: number
  /** The open ping is `/cache-keeper:ping`'s: logged as `manual-ping`, never scored. */
  pingManual?: boolean
  /** That manual ping came from the band: no command turn follows it. */
  pingButton?: boolean
  /** A failed fork waits on the mod's retry timer (not in flight). */
  forkRetryParked?: boolean
  /** Cleared by the next turn `record` closes. */
  lastError?: { at: number; cmd: string; message: string }
  errorNoticeAt?: number
  /** Epoch ms since the main thread waits at AskUserQuestion; the turn is open. */
  waitingSince?: number
  /** Epoch ms of the last main-thread request Claude Code itself saw (a real turn or a wake turn). Policy reads it as Claude Code's own clock. */
  lastRequestAt?: number
  /** Epoch ms the request that last read or wrote the server cache started (a fork ping: when it was sent); only the status line reads it. */
  cacheAnchorAt?: number
  /** Fork pings sent since `lastRequestAt`. */
  forkPingsHeld?: number
  /** Epoch ms of the last compaction, reported by the mod. */
  compactedAt?: number
}

export interface AwayBudget {
  awayPingsSincePresence: number
  updatedAt?: number
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

export function safeId(sessionId: string): string {
  // INVARIANT: an id that is not a plain UUID is flattened so it cannot escape the sessions directory.
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return cleaned === '' ? '_' : cleaned
}

export function sessionPath(home: string, sessionId: string): string {
  return join(home, 'sessions', `${safeId(sessionId)}.json`)
}

export function newSession(sessionId: string): SessionState {
  return { sessionId, ctxTokens: 0, pingsSoFar: 0, pendingPing: false, lastPingHit: null }
}

export function loadSession(home: string, sessionId: string): SessionState | undefined {
  const s = readJson<SessionState>(sessionPath(home, sessionId))
  return s && typeof s === 'object' ? { ...newSession(sessionId), ...s } : undefined
}

export function saveSession(home: string, state: SessionState): void {
  writeJsonAtomic(sessionPath(home, state.sessionId), state)
}

export function deleteSession(home: string, sessionId: string): void {
  rmSync(sessionPath(home, sessionId), { force: true })
  rmSync(forkClaimPath(home, sessionId), { force: true })
}

/** When the plugin's mod last took this session's pings. */
// WARNING: a file apart from the session's: the mod claims at turn end, just when `record` rewrites the
// session file, and one write would drop the other's.
export function forkClaimPath(home: string, sessionId: string): string {
  return join(home, 'forks', `${safeId(sessionId)}.json`)
}

export function loadForkClaim(home: string, sessionId: string): number | undefined {
  const at = readJson<{ armedAt?: unknown }>(forkClaimPath(home, sessionId))?.armedAt
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined
}

export function saveForkClaim(home: string, sessionId: string, armedAt: number): void {
  writeJsonAtomic(forkClaimPath(home, sessionId), { armedAt })
}

export function awayBudgetPath(home: string): string {
  return join(home, 'away-budget.json')
}

export function loadAwayBudget(home: string): AwayBudget {
  const b = readJson<AwayBudget>(awayBudgetPath(home))
  const n = b?.awayPingsSincePresence
  return { awayPingsSincePresence: typeof n === 'number' && n >= 0 ? n : 0, updatedAt: b?.updatedAt }
}

export function saveAwayBudget(home: string, budget: AwayBudget): void {
  writeJsonAtomic(awayBudgetPath(home), budget)
}

export const ARM_SLACK_MS = 60_000

/** Does the plugin's mod send this session's pings as forks? Then the Stop sleeper stands down. */
export function forkOwns(state: SessionState, config: Config): boolean {
  if (!config.forkPings) return false
  const armedAt = loadForkClaim(config.home, state.sessionId)
  return armedAt !== undefined && armedAt >= (state.lastTurnEndAt ?? 0) - ARM_SLACK_MS
}

/** A compaction since the last request: the new prefix is in no cache yet, so there is nothing to hold. */
export function compactedSinceRequest(state: SessionState): boolean {
  // WORKAROUND: measured, a fork after /compact sent the compacted 42k uncached and wrote none of it; a wake
  // turn would write it all, which the person's own next turn pays anyway.
  return state.compactedAt !== undefined && state.compactedAt >= (state.lastRequestAt ?? 0)
}

/** When the cache goes cold if nothing else is sent; undefined while nothing was sent. */
// WARNING: this counts from `lastTurnEndAt` with the config TTL, as the ping timer does. The status line (hooks/status.ts) anchors at `cacheAnchorAt`
// (the request's start) with the bucket the turn wrote, because that is when the server's clock runs; the two ends can differ.
export function warmUntilOf(state: SessionState | undefined, cacheTtlSec: number): number | undefined {
  const last = state?.lastTurnEndAt
  return last === undefined || last === 0 ? undefined : last + cacheTtlSec * 1000
}

/** Scored, failed for good, or overtaken by a real prompt. */
export function closePing(state: SessionState): void {
  state.pendingPing = false
  delete state.pingManual
  delete state.pingButton
  delete state.forkRetries
  delete state.forkRetryParked
}
