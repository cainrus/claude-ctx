/** The hook subcommands (record, wake, touch, gate, person, end): hook input plus an explicit context in, exit code out. */

import { rmSync } from 'node:fs'
import type { Config } from './config.ts'
import { askBlockIf, coldFacts, isMachinePrompt, keeperColdStop, slashCommandOf, type BlockIfAnswer, type BlockIfInput } from './cold-stop.ts'
import { handoffMessage, interceptPrompt, requestHandoff, settleHandoff, wantsHandoff, type HandoffIO } from './handoff.ts'
import { appendLedger, type RefusalReason } from './ledger.ts'
import { postNotice, takeNotices } from './notices.ts'
import { addPingCost, turnPrices } from './report.ts'
import { statusReport } from './inspect.ts'
import { decide, isAtKeyboard } from './policy.ts'
import { isJobLaunchPrompt } from './presence.ts'
import {
  closePing,
  compactedSinceRequest,
  deleteSession,
  forkOwns,
  loadAwayBudget,
  loadSession,
  newSession,
  personPath,
  readJson,
  saveAwayBudget,
  saveSession,
  writeJsonAtomic,
  type PersonFacts,
  type SessionState,
} from './state.ts'
import { firstMainUsageSince, lastMainTurn, scanFirstMainUsage, type MainTurn } from './transcript.ts'
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
  /** person only: epoch ms the prompt was submitted. */
  at?: number
  /** person only: the prompt's origin is the person's own (composer or bridge). */
  person?: boolean
  /** person only: the prompt's slash command name, without the slash. */
  command?: string
  /** person only, with `person`: the prompt's text (its head, for a long one), to tell a background job's launch prompt apart. */
  text?: string
  /** person only: the whole prompt's length when `text` is its head. */
  text_length?: number
  /** person only: the prompt stamped `at` entered the session (no hook dropped it), or keeper's gate refused it after that. */
  phase?: 'entered' | 'refused'
}

const GATE_STOP_WINDOW_MS = 30_000
/** The longest from the prompt hook letting a prompt through to its turn's first request: the other prompt hooks run in between. */
const PROMPT_HOOK_GATE_MS = 120_000
/** How much of a prompt the stamp keeps: enough to tell the gate's ask for it from a command typed after it. */
const PROMPT_HEAD_CHARS = 200

/** The stamp's key: a slash command by its name (the gate may see it engine-tagged), any other prompt by its head. */
function promptKey(prompt: string): string {
  const command = slashCommandOf(prompt)
  return command !== undefined ? `/${command}` : prompt.slice(0, PROMPT_HEAD_CHARS)
}
const PROMPT_STAMP_SLACK_MS = 5_000

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
  /** The environment the config came from, for `/ctx:status`. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** The `coldStop.blockIf` command, asked on every prompt keeper does not answer itself. */
  blockIf?: (input: BlockIfInput) => BlockIfAnswer
}

const blockingSleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** How long `record` waits for the transcript to catch up with the turn it closes. */
export const TRANSCRIPT_CATCH_UP_MS = 3000
const CATCH_UP_STEP_MS = 100

function mainTurnSince(path: string, sinceMs: number, ctx: Ctx): MainTurn {
  const sleep = ctx.sleepMs ?? blockingSleep
  // WORKAROUND: the Stop hook can run before Claude Code flushed the turn's assistant entry (seen live), and a read then
  // returns the PREVIOUS turn's usage. Poll for an entry no older than the turn's start; undefined = record it unscored.
  for (let waited = 0; ; waited += CATCH_UP_STEP_MS) {
    const turn = lastMainTurn(path, undefined, sinceMs)
    const usage = turn.usage
    if (usage && (usage.timestamp === undefined || usage.timestamp >= sinceMs)) return turn
    // Not caught up: any request start in the file belongs to an earlier turn.
    if (waited >= TRANSCRIPT_CATCH_UP_MS) return {}
    sleep(CATCH_UP_STEP_MS)
  }
}

const iso = (ms: number) => new Date(ms).toISOString()
const secondsBetween = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 1000))

export function isWakePrompt(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && prompt.includes(WAKE_MARKER)
}

export const DONE_COMMAND = '/ctx:done'

function isCommand(prompt: string | undefined, command: string): boolean {
  if (typeof prompt !== 'string') return false
  const p = prompt.trim()
  return p === command || p.startsWith(`${command} `)
}

export function isDoneCommand(prompt: string | undefined): boolean {
  return isCommand(prompt, DONE_COMMAND)
}

/** Answered by the prompt hook itself, like `done`. */
export const STATUS_COMMAND = '/ctx:status'

export function isStatusCommand(prompt: string | undefined): boolean {
  return isCommand(prompt, STATUS_COMMAND)
}

/** Let through by the prompt hook: the mod answers its turn with a fork, or commands/ping.md reaches the model as a wake turn. */
export const PING_COMMAND = '/ctx:ping'
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
  const turn: MainTurn = state.transcriptPath ? mainTurnSince(state.transcriptPath, turnBegan, ctx) : {}
  const { usage } = turn

  // WARNING: the TTL restarted at the last assistant entry's timestamp, not this hook's clock. With delay == minAgeSec,
  // "now" could land after the sleeper this Stop started and make it look stale. An entry older than the last prompt = not caught up: now.
  const ts = usage?.timestamp
  state.lastTurnEndAt = ts !== undefined && ts >= (state.lastHumanAt ?? 0) ? Math.min(ts, ctx.now) : ctx.now
  // WARNING: lastRequestAt stays Claude Code's own clock (compactedSinceRequest, compactCheck's #105017 test read it): never the request start.
  state.lastRequestAt = state.lastTurnEndAt
  // The server's clock runs from the request's start. Trusted only inside this turn and not after its answer; else the answer time.
  // WARNING: the prompt's transcript entry is stamped before UserPromptSubmit runs (median 0.9 s, p25 1.4 s earlier on 243
  // sessions, 26.11.2026), so "inside this turn" starts PROMPT_STAMP_SLACK_MS before turnBegan; without it a turn with no
  // tool call never anchors at its start.
  const started = turn.requestStart
  const inTurn = started !== undefined && started >= turnBegan - PROMPT_STAMP_SLACK_MS && started <= state.lastTurnEndAt
  state.cacheAnchorAt = inTurn ? started : state.lastTurnEndAt
  state.forkPingsHeld = 0

  if (usage) {
    state.ctxTokens = usage.ctxTokens
    if (usage.model) state.model = usage.model
    Object.assign(state, turnPrices(state.ctxTokens, state.model, ctx.config.prices))
    // A read-only last request keeps the bucket an earlier request of the same turn wrote; a turn that wrote none keeps the previous one.
    if (turn.ttlSec !== undefined) state.cacheTtlSec = turn.ttlSec
    // 0 = searched and not found (a first request out of the cap); an open or read error leaves it unset, so a later Stop tries again.
    if (state.coldStartTokens === undefined) {
      const first = state.transcriptPath ? scanFirstMainUsage(state.transcriptPath) : { complete: true }
      if (first.usage) state.coldStartTokens = first.usage.ctxTokens
      else if (first.complete) state.coldStartTokens = 0
    }
  }
  if (state.coldStartTokens) state.coldStartUsd = turnPrices(state.coldStartTokens, state.model, ctx.config.prices).coldTurnUsd

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
      const entry = {
        t: iso(ctx.now),
        sessionId: sid,
        event: manual ? 'manual-ping' : hit ? 'wake-hit' : 'wake-miss',
        ...(state.lastPingAt !== undefined ? { sentAt: iso(state.lastPingAt) } : {}),
        ...(handoffTurn && !manual ? { detail: 'handoff' } : {}),
        ctxTokens: usage.ctxTokens,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        outputTokens: usage.outputTokens,
      } as const
      addPingCost(state, entry, ctx.config.prices)
      appendLedger(home, entry)
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
/** The longest a manual fork takes, the mod's timeout and the CLI calls around it included. */
export const MANUAL_FORK_MAX_MS = 140_000

/**
 * Whether an open ping still blocks another. A band press's fork is closed by `forked` within
 * MANUAL_FORK_MAX_MS or never (the CLI call after it failed, and no turn follows to close it), so
 * it stops blocking then, not after the window a wake turn may need.
 */
export function pingInFlight(state: SessionState, now: number): boolean {
  if (!state.pendingPing) return false
  return now - (state.lastPingAt ?? 0) < (state.pingButton ? MANUAL_FORK_MAX_MS : PING_IN_FLIGHT_MS)
}

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
  if (pingInFlight(state, ctx.now)) return { kind: 'none' }
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
    delete state.pingButton
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
  delete state.pingButton
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

  const prompt = input.prompt ?? ''
  const blocked = (reason: string): number => {
    if (gate && input.gate_turn) state.gateTurnAt = ctx.now
    saveSession(home, state)
    ctx.stdout?.(`${JSON.stringify({ decision: 'block', reason })}\n`)
    return 0
  }

  // WARNING: the mod's gate asks at every turn's first request; the prompt the UserPromptSubmit hook let through just before
  // met the stops there (blockIf asked once). Its stamp, matched by the text, is spent by that one ask.
  const passed = state.promptHookPassed
  const seenByPromptHook = gate && passed !== undefined && ctx.now - passed.at < PROMPT_HOOK_GATE_MS && promptKey(prompt) === passed.head
  if (gate) delete state.promptHookPassed
  const cs = ctx.config.coldStop
  // the gate's text is cut at the mod's held-text cap: a launch prompt longer than that is matched by its head
  const stopsOn = ctx.config.enabled && !seenByPromptHook && (cs.enabled || ctx.blockIf !== undefined) && !isMachinePrompt(prompt, ctx.env ?? process.env, gate)
  const facts = stopsOn ? coldFacts(prompt, state, ctx.config, ctx.now, gate) : undefined
  // WARNING: blockIf before the handoff menu: the menu marks its brief used as it answers, and a later hold would burn it.
  const outside = facts && ctx.blockIf ? askBlockIf(prompt, state, ctx.config, ctx.now, facts, ctx.blockIf) : undefined
  if (outside?.kind === 'block') return blocked(outside.reason)

  const stillHeld = (): boolean =>
    ctx.skipIf?.({ sessionId: sid, transcriptPath: state.transcriptPath, lastPromptAt: state.lastHumanAt }) === 'handoff'
  const background = ctx.background?.(state.transcriptPath) ?? false
  // a pass skips the menu only once a stop showed the price; else the menu is the price
  const skipMenu = outside?.kind === 'pass' && facts?.acked === true
  const held = skipMenu ? undefined : interceptPrompt(prompt, state, ctx.config, ctx.now, ctx.handoffIO, gate, stillHeld, background)
  if (held?.kind === 'block') return blocked(held.reason)

  const stop = facts && outside === undefined && held === undefined ? keeperColdStop(state, ctx.config, ctx.now, facts, gate) : undefined
  if (stop?.kind === 'block') return blocked(stop.reason)
  if (!gate) state.promptHookPassed = { at: ctx.now, head: promptKey(prompt) }
  // the gate's answer carries no context to the model: it reaches it with the next typed prompt, as the menu's does
  if (gate && outside?.context) postNotice(home, outside.context, ctx.now, [sid])

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
  const context = [...notes, ...(held?.context ? [held.context] : []), ...(!gate && outside?.context ? [outside.context] : [])]
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

/**
 * The mod's `prompt.submit`, every prompt: sets `promptAt`; a prompt the mod passes as the person's own also sets
 * `personAt` and `personCommand`, unless it is a background job's launch prompt.
 */
export function person(input: HookInput, ctx: Ctx): number {
  const sid = input.session_id
  if (!sid) return 0
  const path = personPath(ctx.config.home, sid)
  const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : ctx.now
  if (input.phase !== undefined) {
    const known = readJson<PersonFacts>(path)
    // a phase a newer mod may send and this keeper does not know changes nothing
    const change = input.phase === 'entered' ? enterPerson : input.phase === 'refused' ? refusePerson : undefined
    const next = known && change?.(known, at)
    if (next) writeJsonAtomic(path, next)
    return 0
  }
  const facts: PersonFacts = { ...readJson<PersonFacts>(path), promptAt: at }
  const textLength = typeof input.text_length === 'number' ? input.text_length : undefined
  if (input.person === true && !isJobLaunchPrompt(input.text, ctx.env ?? process.env, textLength)) {
    facts.personAt = at
    if (typeof input.command === 'string' && input.command !== '') facts.personCommand = input.command
    else delete facts.personCommand
  }
  writeJsonAtomic(path, facts)
  return 0
}

/** Only the prompt `person` counted as the person's (its personAt is `at`) can enter: a launch prompt or a peer's never does. */
function enterPerson(facts: PersonFacts, at: number): PersonFacts | undefined {
  if (facts.personAt !== at || facts.personEnteredAt === at) return undefined
  const next: PersonFacts = { ...facts, personEnteredAt: at }
  if (facts.personEnteredAt !== undefined) {
    next.personEnteredBefore = { at: facts.personEnteredAt, ...(facts.personEnteredCommand ? { command: facts.personEnteredCommand } : {}) }
  } else delete next.personEnteredBefore
  if (facts.personCommand) next.personEnteredCommand = facts.personCommand
  else delete next.personEnteredCommand
  return next
}

function refusePerson(facts: PersonFacts, at: number): PersonFacts | undefined {
  if (facts.personEnteredAt !== at) return undefined
  const next: PersonFacts = { ...facts }
  delete next.personEnteredAt
  delete next.personEnteredCommand
  delete next.personEnteredBefore
  const before = facts.personEnteredBefore
  if (before) {
    next.personEnteredAt = before.at
    if (before.command) next.personEnteredCommand = before.command
  }
  return next
}

/** SessionEnd: drop the session's state and person facts; a sleeper still pending finds nothing and exits 0. */
export function end(input: HookInput, ctx: Ctx): number {
  if (input.session_id) {
    deleteSession(ctx.config.home, input.session_id)
    rmSync(personPath(ctx.config.home, input.session_id), { force: true })
  }
  return 0
}
