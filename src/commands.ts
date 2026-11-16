/** The hook subcommands (record, wake, touch, gate, end): hook input plus an explicit context in, exit code out. */

import type { Config } from './config.ts'
import { handoffMessage, interceptPrompt, requestHandoff, settleHandoff, wantsHandoff, type HandoffIO } from './handoff.ts'
import { appendLedger, type RefusalReason } from './ledger.ts'
import { takeNotices } from './notices.ts'
import { logPingCost, turnPrices } from './report.ts'
import { statusReport } from './inspect.ts'
import { decide, isAtKeyboard } from './policy.ts'
import {
  closePing,
  compactedSinceRequest,
  deleteSession,
  forkOwns,
  loadAwayBudget,
  loadSession,
  newSession,
  saveAwayBudget,
  saveSession,
  type SessionState,
} from './state.ts'
import { firstMainUsageSince, lastMainUsage } from './transcript.ts'
import { tunedMaxPings } from './tune.ts'
import type { SessionFacts, Verdict } from './veto.ts'
import { WAKE_REPLY } from './wake-text.ts'

export const WAKE_MARKER = '[cache-keeper] Prompt-cache keep-alive.'
export const WAKE_MESSAGE = `${WAKE_MARKER} ${WAKE_REPLY}`

export interface HookInput {
  session_id?: string
  transcript_path?: string
  hook_event_name?: string
  stop_hook_active?: boolean
  prompt?: string
  /** gate only: the mod is answering a model turn (turn.step), so a Stop will follow. */
  gate_turn?: boolean
}

const GATE_STOP_WINDOW_MS = 30_000

export interface Ctx {
  config: Config
  /** Epoch ms. */
  now: number
  /** Keyboard idle seconds, null = unknown. Called at most once per wake. */
  idleSeconds: () => number | null
  stderr: (text: string) => void
  /** Blocking sleep; defaults to Atomics.wait. */
  sleepMs?: (ms: number) => void
  /** The `skipIf` veto; asked only when a ping or a handoff would go out. */
  skipIf?: (facts: SessionFacts) => Verdict
  /** Hook stdout (UserPromptSubmit JSON). */
  stdout?: (text: string) => void
  /** Spawn and close for the handoff menu. */
  handoffIO?: HandoffIO
  /** Is this a background session, nobody at its input box (presence.ts)? Asked only at the menu. */
  background?: (transcriptPath?: string) => boolean
  /** The environment the config came from, for `/cache-keeper:status`. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

const blockingSleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** How long `record` waits for the transcript to catch up with the turn it closes. */
export const TRANSCRIPT_CATCH_UP_MS = 3000
const CATCH_UP_STEP_MS = 100

function usageSince(path: string, sinceMs: number, ctx: Ctx) {
  const sleep = ctx.sleepMs ?? blockingSleep
  // WORKAROUND: the Stop hook can run before Claude Code flushed the turn's assistant entry (seen live), and a read then
  // returns the PREVIOUS turn's usage. Poll for an entry no older than the turn's start; undefined = record it unscored.
  for (let waited = 0; ; waited += CATCH_UP_STEP_MS) {
    const usage = lastMainUsage(path)
    if (usage && (usage.timestamp === undefined || usage.timestamp >= sinceMs)) return usage
    if (waited >= TRANSCRIPT_CATCH_UP_MS) return undefined
    sleep(CATCH_UP_STEP_MS)
  }
}

const iso = (ms: number) => new Date(ms).toISOString()
const secondsBetween = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 1000))

export function isWakePrompt(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && prompt.includes(WAKE_MARKER)
}

export const DONE_COMMAND = '/cache-keeper:done'

function isCommand(prompt: string | undefined, command: string): boolean {
  if (typeof prompt !== 'string') return false
  const p = prompt.trim()
  return p === command || p.startsWith(`${command} `)
}

export function isDoneCommand(prompt: string | undefined): boolean {
  return isCommand(prompt, DONE_COMMAND)
}

/** Answered by the prompt hook itself, like `done`. */
export const STATUS_COMMAND = '/cache-keeper:status'

export function isStatusCommand(prompt: string | undefined): boolean {
  return isCommand(prompt, STATUS_COMMAND)
}

/** Let through by the prompt hook: the mod answers its turn with a fork, or commands/ping.md reaches the model as a wake turn. */
export const PING_COMMAND = '/cache-keeper:ping'
/** How commands/ping.md's body starts. */
export const PING_MARKER = '[cache-keeper:ping]'

/** The typed line, the command's tag, or the command file's body. */
export function isPingCommand(prompt: string | undefined): boolean {
  // INVARIANT: hooks/keepalive.ts `isPingTurn` is the mod's copy of this test; keep the two in step.
  if (typeof prompt !== 'string') return false
  if (isCommand(prompt, PING_COMMAND)) return true
  const p = prompt.trim()
  return p.startsWith(PING_MARKER) || (p.startsWith('<command-') && p.includes(`<command-name>${PING_COMMAND}</command-name>`))
}

export const DONE_REPLY =
  'cache-keeper: this session will not be kept warm. Your next message lifts it. Nothing was sent to the model.'

/** Stop (sync): record the finished turn; if it closed a wake, score the ping. */
export function record(input: HookInput, ctx: Ctx): number {
  const sid = input.session_id
  if (!sid) return 0
  const { home, hitRatio } = ctx.config
  const state = loadSession(home, sid) ?? newSession(sid)
  if (input.transcript_path) state.transcriptPath = input.transcript_path

  // INVARIANT: a turn the gate (or the mod) answered never reached the model: its Stop must not read as a touched cache.
  if (state.gateTurnAt !== undefined) {
    const own = ctx.now - state.gateTurnAt < GATE_STOP_WINDOW_MS
    delete state.gateTurnAt
    if (own) {
      saveSession(home, state)
      return 0
    }
  }

  const turnBegan = state.pendingPing && state.pingTransport !== 'fork' ? (state.lastPingAt ?? 0) : (state.lastHumanAt ?? 0)
  const usage = state.transcriptPath ? usageSince(state.transcriptPath, turnBegan, ctx) : undefined

  // WARNING: the TTL restarted at the last assistant entry's timestamp, not this hook's clock. With delay == minAgeSec,
  // "now" could land after the sleeper this Stop started and make it look stale. An entry older than the last prompt = not caught up: now.
  const ts = usage?.timestamp
  state.lastTurnEndAt = ts !== undefined && ts >= (state.lastHumanAt ?? 0) ? Math.min(ts, ctx.now) : ctx.now
  state.lastRequestAt = state.lastTurnEndAt
  state.forkPingsHeld = 0

  if (usage) {
    state.ctxTokens = usage.ctxTokens
    if (usage.model) state.model = usage.model
    Object.assign(state, turnPrices(state.ctxTokens, state.model, ctx.config.prices))
  }

  // INVARIANT: only a Stop after our own wake turn is scored, never on `stop_hook_active` alone (another Stop hook
  // may have blocked the turn: a spurious miss would mute the session for good). A fork is scored by `forked`.
  const closedWake = state.pendingPing && state.pingTransport !== 'fork'
  if (closedWake) {
    const manual = state.pingManual === true
    const handoffTurn = state.handoffPending === true
    closePing(state)
    if (usage) {
      const denom = usage.cacheRead + usage.cacheWrite
      const hit = denom > 0 && usage.cacheRead / denom >= hitRatio
      if (!manual && !handoffTurn) state.lastPingHit = hit
      logPingCost(home, state, {
        t: iso(ctx.now),
        sessionId: sid,
        event: manual ? 'manual-ping' : hit ? 'wake-hit' : 'wake-miss',
        ...(handoffTurn && !manual ? { detail: 'handoff' } : {}),
        ctxTokens: usage.ctxTokens,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        outputTokens: usage.outputTokens,
      }, ctx.config.prices)
    }
  }

  if (!closedWake && state.resumeAt !== undefined) {
    const paid = usage && state.transcriptPath ? firstMainUsageSince(state.transcriptPath, state.resumeAt) : undefined
    if (paid) {
      appendLedger(home, {
        t: iso(ctx.now),
        sessionId: sid,
        event: 'resume-paid',
        model: paid.model,
        inputTokens: paid.inputTokens,
        cacheRead: paid.cacheRead,
        cacheWrite: paid.cacheWrite,
      })
    }
    delete state.resumeAt
  }

  const handoff = closedWake && state.handoffPending === true
  state.handoffPending = false
  delete state.lastError
  delete state.waitingSince
  saveSession(home, state)
  if (handoff) settleHandoff(home, sid, ctx.now)
  return 0
}

/** A ping sent this recently and not scored yet is still on its way: a second one would double it. */
export const PING_IN_FLIGHT_MS = 10 * 60_000

/** `ping` and `handoff` arrive already recorded, the caller only delivers them; `retryInSec` is for the mod's timer. */
export type WakeOutcome = { kind: 'none'; retryInSec?: number } | { kind: 'ping' } | { kind: 'handoff'; message: string }

/** After the sleep: decide whether this idle session gets a ping (exit 2) or not (exit 0). */
export function wake(input: HookInput, ctx: Ctx): number {
  const sid = input.session_id
  if (!sid) return 0
  const state = loadSession(ctx.config.home, sid)
  if (state && forkOwns(state, ctx.config)) return 0
  const out = decideWake(input, ctx, 'turn')
  if (out.kind === 'none') return 0
  ctx.stderr(`${out.kind === 'ping' ? WAKE_MESSAGE : out.message}\n`)
  return 2
}

/** The decision behind `wake` and the mod's `fork-wake`; `transport` is how a ping would go out. */
export function decideWake(input: HookInput, ctx: Ctx, transport: 'turn' | 'fork'): WakeOutcome {
  const { home, thresholds, enabled } = ctx.config
  const sid = input.session_id
  if (!enabled || !sid) return { kind: 'none' }
  const state = loadSession(home, sid)
  if (!state || state.lastTurnEndAt === undefined) return { kind: 'none' }
  if (state.pendingPing && ctx.now - (state.lastPingAt ?? 0) < PING_IN_FLIGHT_MS) return { kind: 'none' }
  // INVARIANT: a turn held open by a question (fork.ts waitStart) takes only forks: a wake turn or a handoff would land inside it.
  if (state.waitingSince !== undefined && transport === 'turn') return { kind: 'none' }

  const ageSec = secondsBetween(state.lastTurnEndAt, ctx.now)
  const turnStartedSince = (state.lastHumanAt ?? 0) > state.lastTurnEndAt
  if (turnStartedSince) return { kind: 'none' }
  if (ageSec < thresholds.minAgeSec) return { kind: 'none', retryInSec: thresholds.minAgeSec - ageSec + 1 }
  if (compactedSinceRequest(state)) {
    appendLedger(home, { t: iso(ctx.now), sessionId: sid, event: 'skip', reason: 'compacted', ctxTokens: state.ctxTokens, ageSec, model: state.model })
    return { kind: 'none' }
  }

  const awaySeconds = ctx.idleSeconds()
  const atKeyboard = isAtKeyboard(awaySeconds, thresholds)
  const budget = loadAwayBudget(home)
  if (atKeyboard && budget.awayPingsSincePresence !== 0) {
    budget.awayPingsSincePresence = 0
    budget.updatedAt = ctx.now
    saveAwayBudget(home, budget)
  }

  const limits = ctx.config.maxPingsAuto ? { ...thresholds, maxPings: tunedMaxPings(ctx.config, ctx.now) } : thresholds
  const decision = decide(
    {
      awaySeconds,
      ageSec,
      ctxTokens: state.ctxTokens,
      pingsSoFar: state.pingsSoFar,
      awayPingsSincePresence: budget.awayPingsSincePresence,
      lastPingHit: state.lastPingHit,
      muted: state.doneAt !== undefined,
    },
    limits,
  )

  const base = { t: iso(ctx.now), sessionId: sid, ctxTokens: state.ctxTokens, ageSec, model: state.model, awaySeconds }
  const facts = { sessionId: sid, transcriptPath: state.transcriptPath, lastPromptAt: state.lastHumanAt }
  const handoffDue = (reason: RefusalReason): boolean =>
    state.waitingSince === undefined &&
    state.transcriptPath !== undefined &&
    wantsHandoff(
      {
        reason,
        ageSec,
        ctxTokens: state.ctxTokens,
        lastPingHit: state.lastPingHit,
        alreadyRequested: state.handoffRequested === true,
      },
      ctx.config,
    )
  const startHandoff = (auto: boolean): WakeOutcome => {
    const path = requestHandoff(home, state, ctx.now, auto)
    state.pendingPing = true
    state.pingTransport = 'turn'
    delete state.pingManual
    state.handoffRequested = true
    state.handoffPending = true
    state.lastPingAt = ctx.now
    saveSession(home, state)
    return { kind: 'handoff', message: handoffMessage(WAKE_MARKER, path) }
  }
  if (!decision.ping) {
    if (handoffDue(decision.reason)) {
      const verdict = ctx.skipIf?.(facts) ?? 'ping'
      if (verdict !== 'skip') return startHandoff(verdict === 'handoff')
    }
    appendLedger(home, { ...base, event: 'skip', reason: decision.reason })
    return { kind: 'none' }
  }
  const verdict = ctx.skipIf?.(facts) ?? 'ping'
  if (verdict !== 'ping') {
    if (verdict === 'handoff' && handoffDue('holder')) return startHandoff(true)
    appendLedger(home, { ...base, event: 'skip', reason: verdict === 'handoff' ? 'holder' : 'skip-if' })
    return { kind: 'none' }
  }

  state.pendingPing = true
  state.pingTransport = transport
  delete state.forkRetries
  delete state.pingManual
  state.pingsSoFar += 1
  state.lastPingAt = ctx.now
  saveSession(home, state)
  if (!atKeyboard) {
    budget.awayPingsSincePresence += 1
    budget.updatedAt = ctx.now
    saveAwayBudget(home, budget)
  }
  appendLedger(home, { ...base, event: 'ping', pings: state.pingsSoFar, ...(transport === 'fork' ? { transport } : {}) })
  return { kind: 'ping' }
}

/** UserPromptSubmit: a real prompt closes the idle stretch, unless the handoff menu blocks it first. */
export function touch(input: HookInput, ctx: Ctx, gate = false): number {
  const sid = input.session_id
  if (!sid || isWakePrompt(input.prompt) || isPingCommand(input.prompt)) return 0
  const { home } = ctx.config

  if (isStatusCommand(input.prompt)) {
    const s = loadSession(home, sid)
    ctx.stdout?.(`${JSON.stringify({ decision: 'block', reason: statusReport(s, ctx.config, ctx.env ?? process.env, ctx.now) })}\n`)
    if (s && gate && input.gate_turn) {
      s.gateTurnAt = ctx.now
      saveSession(home, s)
    }
    return 0
  }

  const state = loadSession(home, sid) ?? newSession(sid)
  if (input.transcript_path) state.transcriptPath = input.transcript_path

  if (isDoneCommand(input.prompt)) {
    state.doneAt = ctx.now
    saveSession(home, state)
    appendLedger(home, { t: iso(ctx.now), sessionId: sid, event: 'done', ctxTokens: state.ctxTokens, model: state.model })
    ctx.stdout?.(`${JSON.stringify({ decision: 'block', reason: DONE_REPLY })}\n`)
    return 0
  }

  const stillHeld = (): boolean =>
    ctx.skipIf?.({ sessionId: sid, transcriptPath: state.transcriptPath, lastPromptAt: state.lastHumanAt }) === 'handoff'
  const background = ctx.background?.(state.transcriptPath) ?? false
  const held = interceptPrompt(input.prompt ?? '', state, ctx.config, ctx.now, ctx.handoffIO, gate, stillHeld, background)
  if (held?.kind === 'block') {
    if (gate && input.gate_turn) {
      state.gateTurnAt = ctx.now
      saveSession(home, state)
    }
    ctx.stdout?.(`${JSON.stringify({ decision: 'block', reason: held.reason })}\n`)
    return 0
  }

  if (state.pingsSoFar > 0) {
    appendLedger(home, {
      t: iso(ctx.now),
      sessionId: sid,
      event: 'resume',
      pings: state.pingsSoFar,
      lastPingHit: state.lastPingHit,
      ctxTokens: state.ctxTokens,
      model: state.model,
      ...(state.lastTurnEndAt !== undefined ? { ageSec: secondsBetween(state.lastTurnEndAt, ctx.now) } : {}),
    })
    state.resumeAt = ctx.now
  }

  state.pingsSoFar = 0
  closePing(state)
  delete state.gateTurnAt
  state.handoffRequested = false
  state.handoffPending = false
  delete state.doneAt
  delete state.waitingSince
  state.lastHumanAt = ctx.now
  saveSession(home, state)

  const notes = gate ? [] : takeNotices(home, sid, ctx.now)
  const context = [...notes, ...(held?.context ? [held.context] : [])]
  if (context.length > 0) {
    const out: Record<string, unknown> = {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n\n') },
    }
    if (notes.length > 0) out.systemMessage = notes.join('\n')
    ctx.stdout?.(`${JSON.stringify(out)}\n`)
  }
  return 0
}

/** The mod's gate for what UserPromptSubmit never sees (`!`, a slash command, a compaction): `touch`'s decision and JSON. */
export function gate(input: HookInput, ctx: Ctx): number {
  return touch(input, ctx, true)
}

/** SessionEnd: drop the session's state; a sleeper still pending finds nothing and exits 0. */
export function end(input: HookInput, ctx: Ctx): number {
  if (input.session_id) deleteSession(ctx.config.home, input.session_id)
  return 0
}
