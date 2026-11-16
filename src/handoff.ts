/**
 * Handoff: when keeper is about to let a large, still-warm cache die (you are away for hours, or the ping
 * budget is spent), it spends one last warm turn on a brief for a new session, `handoffs/<session>.md`.
 * It is a real turn (in the transcript, about two requests) and renews the cache for another hour.
 * Back while the cache is still warm, nothing is asked. Back after it went
 * cold, your prompt is held before it reaches the model and a menu offers: send it again (or `1`) to continue
 * here, or `2` to start a new session from the brief plus your message (`handoff.spawnCommand`;
 * `handoff.closeAfterSpawn` closes this one). Where the plugin's mod loads, `!` commands, slash commands and
 * `/compact` are held the same way. Off by default: turn on with `handoff.enabled` or `CACHE_KEEPER_HANDOFF=1`.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { appendLedger, type RefusalReason } from './ledger.ts'
import { postNotice } from './notices.ts'
import { rateFor } from './prices.ts'
import { readJson, writeJsonAtomic, type SessionState } from './state.ts'
import { WAKE_REPLY } from './wake-text.ts'

/** Refusals after which the keeper would let a still-warm cache die. */
export const HANDOFF_REASONS: readonly RefusalReason[] = ['away', 'away-budget-spent', 'budget-spent', 'holder']

export const MIN_BRIEF_CHARS = 400

const SPAWN_OUTPUT_CHARS = 600

export type HandoffStatus = 'requested' | 'ready' | 'used' | 'failed'

export interface HandoffRecord {
  sessionId: string
  status: HandoffStatus
  requestedAt: number
  preCtx: number
  model?: string
  transcriptPath: string
  briefPath: string
  readyAt?: number
  failure?: 'no-brief'
  heldPrompt?: string
  menuShownAt?: number
  usedAt?: number
  /** warm = came back before the cache died; here / new = picked in the menu, or by `auto`. */
  choice?: 'warm' | 'here' | 'new'
  continuePath?: string
  /** The session's holder asked for the handoff (`skipIf` exit 3): a cold prompt goes to a new session without the menu. */
  auto?: true
}

const handoffDir = (home: string) => join(home, 'handoffs')
export const briefPath = (home: string, sid: string) => join(handoffDir(home), `${sid}.md`)
export const recordPath = (home: string, sid: string) => join(handoffDir(home), `${sid}.json`)
export const continuePath = (home: string, sid: string) => join(handoffDir(home), `${sid}-continue.md`)

export function loadRecord(home: string, sid: string): HandoffRecord | undefined {
  return readJson<HandoffRecord>(recordPath(home, sid))
}

function saveRecord(home: string, rec: HandoffRecord): void {
  writeJsonAtomic(recordPath(home, rec.sessionId), rec)
}

export interface Eligibility {
  reason: RefusalReason
  ageSec: number
  ctxTokens: number
  lastPingHit: boolean | null
  /** A handoff was already asked for in this idle stretch. */
  alreadyRequested: boolean
}

/** Would this refusal let a warm, large cache die that a brief could save? */
export function wantsHandoff(e: Eligibility, config: Config): boolean {
  const h = config.handoff
  return (
    h.enabled &&
    HANDOFF_REASONS.includes(e.reason) &&
    e.ageSec < config.thresholds.maxAgeSec &&
    e.ctxTokens >= h.minCtxTokens &&
    e.lastPingHit !== false &&
    !e.alreadyRequested
  )
}

/** The brief's section the new session rebuilds its task list from, so the plan continues instead of restarting. */
export const TASK_LIST_HEADING = '## Task list'

export function handoffMessage(marker: string, path: string): string {
  return (
    `${marker} Handoff: this idle session's prompt cache is about to expire. The user may continue in a NEW ` +
    `session that has never seen this conversation. If this session has a task list, first bring it up to date ` +
    `with TaskUpdate (or TodoWrite, if that is your task tool): finished steps completed, the current one ` +
    `in_progress. Then write a self-contained brief ` +
    `for the new session to ${path} with the Write tool: the user's goal and every open request; decisions made ` +
    `and why, and what was ruled out; the current state of the work and of any plan; files, branches and ` +
    `commands that matter; open questions; the exact next step. Under the heading "${TASK_LIST_HEADING}" list ` +
    `every open step in order, one per line as "- [in_progress] subject — what is left" or "- [pending] ...", ` +
    `or write "none". Then add the last few exchanges, condensed, under the heading "## Last exchanges". ` +
    `Change nothing else. After the brief: ` +
    WAKE_REPLY
  )
}

const TASK_LIST_LINE = /^(#{1,6})\s+task list\b/i
const HEADING_LINE = /^(#{1,6})\s/
const FENCE_LINE = /^(?:```|~~~)/
const OPEN_STEP_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|`)?\[(?:pending|in[ _-]?progress)\]/i

/** Open steps (pending, in_progress) listed under the brief's task-list heading, trimmed. */
export function openTaskSteps(brief: string): string[] {
  const steps: string[] = []
  let fenced = false
  let taskListLevel = 0
  for (const line of brief.split('\n').map((l) => l.trim())) {
    if (FENCE_LINE.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    if (!taskListLevel) {
      taskListLevel = TASK_LIST_LINE.exec(line)?.[1].length ?? 0
      continue
    }
    const heading = HEADING_LINE.exec(line)
    if (heading && heading[1].length <= taskListLevel) break
    if (OPEN_STEP_LINE.test(line)) steps.push(line)
  }
  return steps
}

export function requestHandoff(home: string, state: SessionState, now: number, auto = false): string {
  const sid = state.sessionId
  const path = briefPath(home, sid)
  rmSync(path, { force: true })
  saveRecord(home, {
    sessionId: sid,
    status: 'requested',
    requestedAt: now,
    preCtx: state.ctxTokens,
    ...(state.model ? { model: state.model } : {}),
    transcriptPath: state.transcriptPath!,
    briefPath: path,
    ...(auto ? { auto: true as const } : {}),
  })
  appendLedger(home, { t: new Date(now).toISOString(), sessionId: sid, event: 'handoff-request', ctxTokens: state.ctxTokens })
  return path
}

/** Run by the Stop that closes the handoff wake: the brief is `ready`, or `failed` with a one-shot notice. */
export function settleHandoff(home: string, sid: string, now: number): void {
  const rec = loadRecord(home, sid)
  if (!rec || rec.status !== 'requested') return
  let brief = ''
  try {
    brief = readFileSync(rec.briefPath, 'utf8')
  } catch {}
  const t = new Date(now).toISOString()
  if (brief.trim().length < MIN_BRIEF_CHARS) {
    saveRecord(home, { ...rec, status: 'failed', failure: 'no-brief' })
    appendLedger(home, { t, sessionId: sid, event: 'handoff-failed', failure: 'no-brief' })
    postNotice(home, `cache-keeper: session ${sid.slice(0, 8)} was asked for a handoff brief and wrote none.`, now, [sid])
    return
  }
  saveRecord(home, { ...rec, status: 'ready', readyAt: now })
  appendLedger(home, { t, sessionId: sid, event: 'handoff-ready', ctxTokens: rec.preCtx })
}

export interface SpawnResult {
  ok: boolean
  output: string
}

/** The process side, injected so tests spawn nothing. */
export interface HandoffIO {
  /** ok = exit 0. */
  spawn: (command: string, env: Record<string, string>) => SpawnResult
  /** Close this session shortly after the hook has returned. */
  closeLater: (sessionId: string) => void
}

export type Interception =
  /** Let the prompt through; `context` reaches the model with it. */
  | { kind: 'pass'; context?: string }
  /** Stop the prompt before the model; `reason` is shown to the human. */
  | { kind: 'block'; reason: string }

const CONTINUE_HERE = new Set(['1', 'force'])

// WARNING: matches Claude Code's own wrapping of a peer message or task notification (`<cross-session-message …>`,
// `<task-notification>`, maybe after a one-line preamble); if that format changes, they read as typed prompts.
const MACHINE_MESSAGE = /^\s*(?:Another Claude session sent a message:\s*)?<(?:cross-session-message|task-notification)[\s>]/

/** A message another session or a finished task sent, not something a person typed. */
export function isMachineMessage(prompt: string): boolean {
  return MACHINE_MESSAGE.test(prompt)
}

function idleText(ms: number): string {
  const min = Math.floor(ms / 60_000)
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
}

export function coldRewriteUsd(ctxTokens: number, model: string | undefined, config: Config): number {
  return (ctxTokens * rateFor(model, config.prices, ctxTokens).cacheWrite) / 1e6
}

function menuText(rec: HandoffRecord, state: SessionState, config: Config, now: number, gate: boolean): string {
  const ctx = state.ctxTokens || rec.preCtx
  const idle = state.lastTurnEndAt !== undefined ? ` (idle ${idleText(now - state.lastTurnEndAt)})` : ''
  const usd = coldRewriteUsd(ctx, state.model ?? rec.model, config).toFixed(2)
  const spawn = config.handoff.spawnCommand
  const second = spawn
    ? `  2      continue in a new session from the brief, with your message${config.handoff.closeAfterSpawn ? '; this session closes' : ''}`
    : '  2      write the brief plus your message to a file, to start a new session from'
  return [
    `cache-keeper: this session's prompt cache has gone cold${idle}; the next turn re-sends ~${Math.round(ctx / 1000)}k tokens (≈ $${usd}).`,
    `A handoff brief was written before it expired: ${rec.briefPath}`,
    gate
      ? '  Enter  run the same command again to continue here (or send 1)'
      : '  Enter  send the same message again to continue here (or type 1)',
    second,
    gate
      ? 'Your command is held. Nothing was sent to the model.'
      : 'Your message is held and is back in the input box. Nothing was sent to the model.',
  ].join('\n')
}

function cwdOf(transcriptPath: string): string | undefined {
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = JSON.parse(line).cwd
        if (typeof cwd === 'string') return cwd
      } catch {}
    }
  } catch {}
  return undefined
}

function writeContinue(home: string, rec: HandoffRecord): string {
  const path = continuePath(home, rec.sessionId)
  const brief = readFileSync(rec.briefPath, 'utf8').trim()
  const held = rec.heldPrompt?.trim()
  const tail = held ? `\n\n## The user's message on return\n\n${held}\n` : '\n'
  const steps = openTaskSteps(brief)
  const restore = steps.length
    ? `\n\nBefore anything else, restore the task list: create these open steps with TaskCreate (or TodoWrite, ` +
      `if that is your task tool), in this order, then mark the in_progress one:\n\n${steps.join('\n')}`
    : ''
  writeFileSync(
    path,
    `${brief}\n\n(Continued from session ${rec.sessionId}; its full transcript is ${rec.transcriptPath}. ` +
      `Read it only when a detail is missing.)${restore}${tail}`,
  )
  return path
}

function startNew(rec: HandoffRecord, config: Config, io: HandoffIO | undefined, now: number): Interception {
  const home = config.home
  const path = writeContinue(home, rec)
  const { spawnCommand, closeAfterSpawn } = config.handoff
  if (!spawnCommand || !io) {
    saveRecord(home, { ...rec, auto: undefined, continuePath: path })
    return { kind: 'block', reason: `cache-keeper: start a new session from ${path} — this one stays as it is.` }
  }
  const cwd = cwdOf(rec.transcriptPath)
  const r = io.spawn(spawnCommand, {
    CACHE_KEEPER_BRIEF: path,
    CACHE_KEEPER_SESSION_ID: rec.sessionId,
    CACHE_KEEPER_TRANSCRIPT_PATH: rec.transcriptPath,
    ...(cwd ? { CACHE_KEEPER_CWD: cwd } : {}),
  })
  const out = r.output.trim().slice(-SPAWN_OUTPUT_CHARS)
  const t = new Date(now).toISOString()
  if (!r.ok) {
    saveRecord(home, { ...rec, auto: undefined, continuePath: path })
    appendLedger(home, { t, sessionId: rec.sessionId, event: 'handoff-failed', failure: 'spawn' })
    return {
      kind: 'block',
      reason: `cache-keeper: the new session did not start; this one stays.${out ? `\n${out}` : ''}\nBrief: ${path}`,
    }
  }
  saveRecord(home, { ...rec, status: 'used', choice: 'new', usedAt: now, continuePath: path })
  appendLedger(home, { t, sessionId: rec.sessionId, event: 'handoff-new', ctxTokens: rec.preCtx })
  if (closeAfterSpawn) io.closeLater(rec.sessionId)
  return {
    kind: 'block',
    reason: `cache-keeper: continued in a new session${closeAfterSpawn ? '; this one is closing' : ''}.${out ? `\n${out}` : ''}`,
  }
}

function continueUnattended(
  rec: HandoffRecord,
  state: SessionState,
  config: Config,
  now: number,
  gate: boolean,
  prompt: string,
): Interception {
  const home = config.home
  saveRecord(home, { ...rec, status: 'used', choice: 'here', usedAt: now })
  appendLedger(home, {
    t: new Date(now).toISOString(),
    sessionId: rec.sessionId,
    event: 'handoff-here',
    ctxTokens: state.ctxTokens,
    detail: 'unattended',
  })
  const held = rec.heldPrompt?.trim()
  if (!held || held === prompt.trim()) return { kind: 'pass' }
  const text = `A message held by cache-keeper while this session's cache was cold, never sent to the model:\n\n${held}`
  if (gate) {
    postNotice(home, text, now, [rec.sessionId])
    return { kind: 'pass' }
  }
  return { kind: 'pass', context: text }
}

/** Called by touch before it records a prompt: undefined = nothing to do; a block means the prompt never ran. */
export function interceptPrompt(
  prompt: string,
  state: SessionState,
  config: Config,
  now: number,
  io?: HandoffIO,
  gate = false,
  stillHeld?: () => boolean,
  background = false,
): Interception | undefined {
  const home = config.home
  const rec = loadRecord(home, state.sessionId)
  if (!rec || rec.status !== 'ready') return undefined
  const t = new Date(now).toISOString()
  const cold = state.lastTurnEndAt !== undefined && now - state.lastTurnEndAt >= config.cacheTtlSec * 1000

  if (!cold) {
    saveRecord(home, { ...rec, status: 'used', choice: 'warm', usedAt: now })
    return { kind: 'pass' }
  }

  // INVARIANT: a background session has nobody to answer the menu: a held peer message or task notification would
  // freeze it while its sender reads "delivered". It pays the cold turn here; a handoff would leave the sender writing to a closed session.
  if (background && isMachineMessage(prompt)) return continueUnattended(rec, state, config, now, gate, prompt)

  if (rec.auto && !gate && stillHeld?.()) return startNew({ ...rec, heldPrompt: prompt }, config, io, now)

  const text = prompt.trim()
  if (rec.heldPrompt !== undefined) {
    if (text === '2') return startNew(rec, config, io, now)
    if (text === rec.heldPrompt.trim() || CONTINUE_HERE.has(text.toLowerCase())) {
      saveRecord(home, { ...rec, status: 'used', choice: 'here', usedAt: now })
      appendLedger(home, { t, sessionId: rec.sessionId, event: 'handoff-here', ctxTokens: state.ctxTokens })
      return text === rec.heldPrompt.trim()
        ? { kind: 'pass' }
        : { kind: 'pass', context: `The user's message, held while cache-keeper asked where to continue:\n\n${rec.heldPrompt}` }
    }
  }
  // INVARIANT: once the menu is shown its answer decides: `auto` would take the reply (`1`, `2`) as the message.
  const held = { ...rec, auto: undefined, heldPrompt: prompt, menuShownAt: now }
  saveRecord(home, held)
  return { kind: 'block', reason: menuText(held, state, config, now, gate) }
}
