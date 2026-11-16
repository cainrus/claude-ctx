/**
 * Fork pings: where the plugin's mod loads, keeper pings with a fork of the main thread instead of a wake turn.
 * A fork re-sends the last request with one short question, so the cache is read and renewed while nothing
 * is added to the transcript. The policy, budgets and report are the same as for wake turns. A fork that
 * fails is sent again, then falls back to a wake turn while the cache can still be reached warm. Forks also
 * hold the cache while a question (AskUserQuestion) waits for your answer, and `/cache-keeper:ping` uses one.
 * Without the mod (an older Claude Code, mods off) pings are wake turns as before.
 * Off: `"forkPings": false` or `CACHE_KEEPER_FORK=0`.
 */

import { decideWake, MANUAL_FORK_MAX_MS, pingInFlight, WAKE_MARKER, WAKE_MESSAGE, type Ctx, type HookInput } from './commands.ts'
import { groupedTokens, hhmm, NOTHING_TO_HOLD } from './format.ts'
import { appendLedger } from './ledger.ts'
import { addPingCost } from './report.ts'
import { closePing, compactedSinceRequest, forkOwns, loadSession, saveForkClaim, saveSession, warmUntilOf } from './state.ts'

export const FORK_PROMPT = `${WAKE_MARKER} Reply with exactly "ok".`

/** What the mod hands `forked`: `$.model.fork`'s result, as it came back. */
export interface ForkResult {
  isAnswered: boolean
  reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface ForkInput extends HookInput {
  /** arm: the mod reloaded mid-stretch, so time the next ping from the last turn. */
  reload?: boolean
  /** forked: the fork's result. */
  fork?: ForkResult
  /** compact-check: `session.compact`'s trigger. */
  trigger?: string
  /** ping-now: pressed on the band, so no command turn follows to carry a fallback or to be gated. */
  button?: boolean
}

export type ForkAnswer =
  | { action: 'none'; dueInSec?: number; text?: string }
  | { action: 'fork'; prompt: string }
  | { action: 'turn'; text: string }
  | { action: 'pass' }
  | { action: 'renew'; text: string }
  | { action: 'retry'; afterSec: number }

const iso = (ms: number) => new Date(ms).toISOString()
const finiteOrZero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function answer(ctx: Ctx, a: ForkAnswer): number {
  ctx.stdout?.(`${JSON.stringify(a)}\n`)
  return 0
}

/** The mod takes this session's pings: after a turn the next is due one full delay later, after a reload what is left of it. */
export function arm(input: ForkInput, ctx: Ctx, env: NodeJS.ProcessEnv = process.env): number {
  const sid = input.session_id
  const { home, enabled, forkPings, delaySec, thresholds } = ctx.config
  if (!sid || !enabled || !forkPings || env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return answer(ctx, { action: 'none' })
  const state = loadSession(home, sid)
  if (!state) return answer(ctx, { action: 'none' })
  if (!input.reload) {
    saveForkClaim(home, sid, ctx.now)
    return answer(ctx, { action: 'none', dueInSec: delaySec })
  }
  if (state.lastTurnEndAt === undefined) return answer(ctx, { action: 'none' })
  const age = Math.floor((ctx.now - state.lastTurnEndAt) / 1000)
  if (age >= thresholds.maxAgeSec) return answer(ctx, { action: 'none' })
  saveForkClaim(home, sid, ctx.now)
  // WARNING: a fork in flight did not survive the reload: nothing will score it,
  // nor will the turn that fork answered end in a Stop the gate mark could wait for.
  if (state.pendingPing && state.pingTransport === 'fork') {
    closePing(state)
    delete state.gateTurnAt
    saveSession(home, state)
  }
  return answer(ctx, { action: 'none', dueInSec: Math.max(1, delaySec - age) })
}

/** The mod's timer fired: the same decision as the Stop sleeper's `wake`, delivered as JSON. */
export function forkWake(input: ForkInput, ctx: Ctx): number {
  const state = input.session_id ? loadSession(ctx.config.home, input.session_id) : undefined
  if (!state || !forkOwns(state, ctx.config)) return answer(ctx, { action: 'none' })
  const out = decideWake(input, ctx, 'fork')
  if (out.kind === 'ping') return answer(ctx, { action: 'fork', prompt: FORK_PROMPT })
  if (out.kind === 'handoff') return answer(ctx, { action: 'turn', text: out.message })
  return answer(ctx, out.retryInSec !== undefined ? { action: 'none', dueInSec: out.retryInSec } : { action: 'none' })
}

/** The mod saw a compaction finish (not a precompute, not a skipped one). */
export function compacted(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const state = sid ? loadSession(ctx.config.home, sid) : undefined
  if (state) {
    state.compactedAt = ctx.now
    saveSession(ctx.config.home, state)
  }
  return answer(ctx, { action: 'none' })
}

/** The same from the `SessionStart` hook after a compaction (source `compact`), for a session without the mod. */
export function compactedStart(input: HookInput, ctx: Ctx): number {
  const sid = input.session_id
  const state = sid ? loadSession(ctx.config.home, sid) : undefined
  if (state && (state.compactedAt === undefined || state.compactedAt < ctx.now)) {
    state.compactedAt = ctx.now
    saveSession(ctx.config.home, state)
  }
  // WARNING: prints nothing: a SessionStart hook's stdout reaches the model.
  return 0
}

/** The mod saw the main thread stop at AskUserQuestion: fork pings hold the cache until it is answered. */
export function waitStart(input: ForkInput, ctx: Ctx, env: NodeJS.ProcessEnv = process.env): number {
  const sid = input.session_id
  const { home, enabled, forkPings, delaySec } = ctx.config
  if (!sid || !enabled || !forkPings || env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return answer(ctx, { action: 'none' })
  const state = loadSession(home, sid)
  if (!state || state.lastTurnEndAt === undefined) return answer(ctx, { action: 'none' })
  // WORKAROUND: the open turn gets no Stop, so no sleeper; an answer an hour later rewrote the whole context
  // (#3683: 8 such rewrites in a week, longest wait 45 h). The asking request just renewed the cache: the stretch starts now.
  state.lastTurnEndAt = ctx.now
  state.lastRequestAt = ctx.now
  state.forkPingsHeld = 0
  state.waitingSince = ctx.now
  saveSession(home, state)
  saveForkClaim(home, sid, ctx.now)
  return answer(ctx, { action: 'none', dueInSec: delaySec })
}

/** The question was answered (or the call ended otherwise): the person is back, as with a real prompt. */
export function waitEnd(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const state = sid ? loadSession(ctx.config.home, sid) : undefined
  if (!sid || !state || state.waitingSince === undefined) return answer(ctx, { action: 'none' })
  if (state.pingsSoFar > 0) {
    appendLedger(ctx.config.home, {
      t: iso(ctx.now),
      sessionId: sid,
      event: 'resume',
      detail: 'question',
      pings: state.pingsSoFar,
      lastPingHit: state.lastPingHit,
      ctxTokens: state.ctxTokens,
      model: state.model,
      ageSec: cacheAgeSec(state, ctx.now),
    })
    state.resumeAt = ctx.now
  }
  if (state.pendingPing && state.pingTransport === 'fork' && state.forkRetryParked) closePing(state)
  state.pingsSoFar = 0
  state.lastHumanAt = ctx.now
  delete state.waitingSince
  saveSession(ctx.config.home, state)
  return answer(ctx, { action: 'none' })
}

/** Forks re-sent for one ping before it falls back to the wake turn. */
export const MAX_FORK_RETRIES = 2
/** Pause before a re-sent fork: a failure is mostly the network or the API, rarely gone at once. */
export const FORK_RETRY_SEC = 60
// INVARIANT: the mod's own limit on one fork, hooks/keepalive.ts FORK_TIMEOUT_MS; keep the two in step.
export const FORK_TIMEOUT_SEC = 120
const FINAL_FORK_FAILURES = new Set(['nothing-to-fork'])

function cacheAgeSec(state: { lastTurnEndAt?: number }, now: number): number {
  return Math.floor((now - (state.lastTurnEndAt ?? 0)) / 1000)
}

/** Scores a fork like `record` scores a wake turn; a failed one is sent again, falls back to a wake turn, or is dropped. */
export function forked(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, hitRatio, delaySec, thresholds } = ctx.config
  if (!sid) return answer(ctx, { action: 'none' })
  const state = loadSession(home, sid)
  if (!state || !state.pendingPing || state.pingTransport !== 'fork') return answer(ctx, { action: 'none' })
  const f = input.fork
  const base = { t: iso(ctx.now), sessionId: sid, ctxTokens: state.ctxTokens, model: state.model }

  if (!f?.isAnswered || !f.usage) {
    const failure = f?.reason ?? 'no-result'
    const ageSec = cacheAgeSec(state, ctx.now)
    const retries = state.forkRetries ?? 0
    // INVARIANT: no fallback turn once the person is back or a question holds the turn open: it would land inside their turn.
    // Nothing goes out past maxAgeSec (measured: a fallback delayed by an outage landed 13 min late and wrote 436k).
    const manual = state.pingManual === true
    const personBack = (state.lastHumanAt ?? 0) > (state.lastPingAt ?? 0)
    const retry =
      !manual &&
      !personBack &&
      !FINAL_FORK_FAILURES.has(failure) &&
      retries < MAX_FORK_RETRIES &&
      ageSec + FORK_RETRY_SEC + FORK_TIMEOUT_SEC <= thresholds.maxAgeSec
    const waiting = state.waitingSince !== undefined
    // A band press has no command turn to fall back into: its failed fork is dropped.
    const button = state.pingButton === true
    const next = retry ? 'retry' : button ? 'drop' : manual || (!waiting && !personBack && ageSec < thresholds.maxAgeSec) ? 'turn' : 'drop'
    appendLedger(home, { ...base, event: 'fork-failed', failure, next, ageSec })
    state.lastPingAt = ctx.now
    if (next === 'retry') {
      state.forkRetries = retries + 1
      state.forkRetryParked = true
      saveSession(home, state)
      return answer(ctx, { action: 'retry', afterSec: FORK_RETRY_SEC })
    }
    delete state.forkRetries
    if (next === 'drop') {
      closePing(state)
      saveSession(home, state)
      // No turn follows a press to re-arm the mod's timer, which may have fired and died while this fork was out.
      if (button) {
        const dueInSec = Math.max(1, thresholds.minAgeSec - ageSec + 1)
        return answer(ctx, { action: 'none', dueInSec, text: `cache-keeper: no ping sent: the fork failed (${failure}).` })
      }
      return answer(ctx, personBack ? { action: 'none', dueInSec: delaySec } : { action: 'none' })
    }
    state.pingTransport = 'turn'
    if (manual) delete state.gateTurnAt
    saveSession(home, state)
    return answer(ctx, { action: 'turn', text: WAKE_MESSAGE })
  }

  const usage = {
    inputTokens: finiteOrZero(f.usage.input_tokens),
    cacheRead: finiteOrZero(f.usage.cache_read_input_tokens),
    cacheWrite: finiteOrZero(f.usage.cache_creation_input_tokens),
    outputTokens: finiteOrZero(f.usage.output_tokens),
  }
  const manual = state.pingManual === true
  const button = state.pingButton === true
  const personBack = (state.lastHumanAt ?? 0) > (state.lastPingAt ?? 0)
  closePing(state)
  if (!personBack) state.lastTurnEndAt = ctx.now
  state.forkPingsHeld = (state.forkPingsHeld ?? 0) + 1
  saveForkClaim(home, sid, ctx.now)

  if (manual) {
    if (!button) state.gateTurnAt = ctx.now
    const entry = { ...base, event: 'manual-ping', transport: 'fork', ...usage } as const
    addPingCost(state, entry, ctx.config.prices)
    saveSession(home, state)
    appendLedger(home, entry)
    return answer(ctx, { action: 'none', dueInSec: delaySec, text: manualPingText(usage, ctx.now + ctx.config.cacheTtlSec * 1000) })
  }

  const denom = usage.cacheRead + usage.cacheWrite + usage.inputTokens
  const hit = denom > 0 && usage.cacheRead / denom >= hitRatio
  state.lastPingHit = hit
  const entry = { ...base, event: hit ? 'wake-hit' : 'wake-miss', transport: 'fork', ...usage } as const
  addPingCost(state, entry, ctx.config.prices)
  saveSession(home, state)
  appendLedger(home, entry)
  return answer(ctx, { action: 'none', dueInSec: delaySec })
}

/** What `/cache-keeper:ping` answers once its fork came back. */
export function manualPingText(u: { cacheRead: number; cacheWrite: number }, warmUntil: number): string {
  if (u.cacheRead === 0) {
    return `cache-keeper: pinged, but nothing was read from the cache: it had gone cold. ${groupedTokens(u.cacheWrite)} tokens written, cached till ${hhmm(warmUntil)}.`
  }
  return `cache-keeper: pinged. Read ${groupedTokens(u.cacheRead)} cached tokens, wrote ${groupedTokens(u.cacheWrite)}; cached till ${hhmm(warmUntil)}.`
}

/** `/cache-keeper:ping` reached the mod: a fork, a refusal, or `pass` (forks off: the command's own turn is the ping). */
export function pingNow(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, enabled, forkPings, cacheTtlSec } = ctx.config
  const state = sid ? loadSession(home, sid) : undefined
  // INVARIANT: a band press has no command turn, so it marks no Stop as the gate's and leaves nothing for a turn to close.
  const button = input.button === true
  const refuse = (why: string) => {
    if (state && !button) {
      state.gateTurnAt = ctx.now
      saveSession(home, state)
    }
    return answer(ctx, { action: 'none', text: `cache-keeper: no ping sent: ${why}.` })
  }
  if (!sid) return refuse('no session id')
  if (!enabled) return refuse('keeper is off (enabled: false)')
  const warmUntil = warmUntilOf(state, cacheTtlSec)
  if (!state || warmUntil === undefined) return refuse(NOTHING_TO_HOLD.noTurn)
  if (ctx.now >= warmUntil) return refuse(NOTHING_TO_HOLD.expired(warmUntil))
  if (compactedSinceRequest(state)) return refuse(NOTHING_TO_HOLD.compacted)
  if (pingInFlight(state, ctx.now)) return refuse('a ping is already on its way')
  if (button && !forkPings) return refuse('the band pings by fork, and forks are off: /cache-keeper:ping sends a turn')
  state.pendingPing = true
  state.pingTransport = forkPings ? 'fork' : 'turn'
  state.pingManual = true
  if (button) state.pingButton = true
  else delete state.pingButton
  state.lastPingAt = ctx.now
  // WARNING: with a fork the mod answers the command's turn, even if the CLI fails after it: that Stop is the mod's.
  // Marked as of the fork's latest end, so a slow one does not push the Stop out of the window.
  if (forkPings && !button) state.gateTurnAt = ctx.now + MANUAL_FORK_MAX_MS
  saveSession(home, state)
  return answer(ctx, forkPings ? { action: 'fork', prompt: FORK_PROMPT } : { action: 'pass' })
}

/** The mod's retry timer fired: the fork goes again unless a turn took the stretch, or it could no longer land warm. */
export function forkRetry(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, thresholds } = ctx.config
  const state = sid ? loadSession(home, sid) : undefined
  if (!state || !state.pendingPing || state.pingTransport !== 'fork' || !state.forkRetries) {
    return answer(ctx, { action: 'none' })
  }
  const turnSince = (state.lastHumanAt ?? 0) > (state.lastPingAt ?? 0)
  const tooLate = cacheAgeSec(state, ctx.now) + FORK_TIMEOUT_SEC > thresholds.maxAgeSec
  if (turnSince || tooLate) {
    closePing(state)
    saveSession(home, state)
    return answer(ctx, { action: 'none' })
  }
  state.lastPingAt = ctx.now
  delete state.forkRetryParked
  saveSession(home, state)
  return answer(ctx, { action: 'fork', prompt: FORK_PROMPT })
}

const TTL_MARGIN_MS = 5 * 60_000

/** A compaction is about to run: a wake turn goes first when forks alone held the cache past the TTL. */
export function compactCheck(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, cacheTtlSec } = ctx.config
  if (!sid || (input.trigger !== 'manual' && input.trigger !== 'plugin')) return answer(ctx, { action: 'pass' })
  const state = loadSession(home, sid)
  if (!state || !state.forkPingsHeld || state.lastRequestAt === undefined || state.lastTurnEndAt === undefined) {
    return answer(ctx, { action: 'pass' })
  }
  // WORKAROUND: anthropics/claude-code#105017: a fork renews the server's cache but not Claude Code's clock, so a compaction
  // that sees no main-thread request within the TTL drops its cache markers and sends the whole context uncached.
  const ttl = cacheTtlSec * 1000
  const engineThinksCold = ctx.now - state.lastRequestAt >= ttl - TTL_MARGIN_MS
  const warm = ctx.now - state.lastTurnEndAt < ttl
  if (!engineThinksCold || !warm) return answer(ctx, { action: 'pass' })
  appendLedger(home, {
    t: iso(ctx.now),
    sessionId: sid,
    event: 'renew',
    ctxTokens: state.ctxTokens,
    model: state.model,
    ageSec: Math.floor((ctx.now - state.lastRequestAt) / 1000),
    pings: state.forkPingsHeld,
  })
  return answer(ctx, { action: 'renew', text: WAKE_MESSAGE })
}
