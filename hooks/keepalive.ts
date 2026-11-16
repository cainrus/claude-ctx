/**
 * Fork pings, the mod side: where Claude Code loads the plugin's mod, keeper pings
 * by forking the main thread's last request with one short question. The API
 * reads the prefix from the cache and renews it, and nothing lands in the
 * transcript. The timer is armed at each turn's end, on session start and while
 * AskUserQuestion waits for an answer; `/cache-keeper:ping` sends one now. Every
 * decision is keeper's, as for the Stop hook's wake turns, and a step that fails
 * sends nothing. `"forkPings": false` in config.json pings with wake turns instead.
 */

import type { EngineInterface, EventOf, EventResult, ModelForkResult } from 'claude-code'

type $ = EngineInterface
type ForkOutcome = ModelForkResult | { isAnswered: false; reason: 'timeout' | 'threw' }

const CLI_TIMEOUT_MS = 20_000
const COMPACT_RETRY_MS = [1_000, 3_000, 10_000]
// WORKAROUND: `$.model.fork` has no timeout of its own (anthropics/claude-code#101446).
const FORK_TIMEOUT_MS = 120_000
const COMPACT_AFTER_TURN_MS = 120_000

type Answer =
  | { action: 'none'; dueInSec?: number; text?: string }
  | { action: 'fork'; prompt: string }
  | { action: 'turn'; text: string }
  | { action: 'pass' }
  | { action: 'renew'; text: string }
  | { action: 'retry'; afterSec: number }

let timer: { cancel: () => void } | undefined
let forking = false
// INVARIANT: once a question is answered nothing arms until its turn's turn.complete: a fork's result would re-arm inside the turn.
let answered = false
let compactAfterTurn: { instructions?: string; at: number } | undefined

async function cli($: $, cmd: string, payload: Record<string, unknown> = {}): Promise<Answer | undefined> {
  try {
    const sessionId = await $.session.id()
    const { exitCode, stdout } = await $.process.run(
      ['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/bin/cache-keeper.ts`, cmd],
      { stdin: JSON.stringify({ session_id: sessionId, ...payload }), timeoutMs: CLI_TIMEOUT_MS },
    )
    const line = exitCode === 0 ? stdout.trim().split('\n').pop() : undefined
    return line ? (JSON.parse(line) as Answer) : undefined
  } catch {
    return undefined
  }
}

function schedule($: $, sec: number | undefined): void {
  timer?.cancel()
  timer = sec === undefined ? undefined : $.clock.after(sec * 1000, () => void tick($))
}

function submit($: $, text: string): void {
  // WARNING: not awaited: it resolves only once the turn starts, which is after the calling hook returns.
  void $.prompt.submit({ text }).catch(() => {})
}

function reschedule($: $, sec: number | undefined): void {
  if (timer === undefined && sec !== undefined && !answered) schedule($, sec)
}

async function fork($: $, prompt: string): Promise<ForkOutcome> {
  let timeout: { cancel: () => void } | undefined
  try {
    return await Promise.race<ForkOutcome>([
      $.model.fork({ prompt }),
      new Promise<ForkOutcome>(resolve => {
        timeout = $.clock.after(FORK_TIMEOUT_MS, () => resolve({ isAnswered: false, reason: 'timeout' }))
      }),
    ])
  } catch {
    return { isAnswered: false, reason: 'threw' }
  } finally {
    timeout?.cancel()
  }
}

function forkResult(r: ForkOutcome) {
  return r.isAnswered ? { isAnswered: true, usage: r.usage } : { isAnswered: false, reason: r.reason }
}

async function tick($: $): Promise<void> {
  timer = undefined
  const a = await cli($, 'fork-wake')
  if (a?.action === 'none') return reschedule($, a.dueInSec)
  if (a?.action === 'turn') return submit($, a.text)
  if (a?.action === 'fork') await sendFork($, a.prompt)
}

async function retryTick($: $): Promise<void> {
  timer = undefined
  const a = await cli($, 'fork-retry')
  if (a?.action === 'fork') await sendFork($, a.prompt)
}

async function sendFork($: $, prompt: string): Promise<void> {
  forking = true
  let r: ForkOutcome
  try {
    r = await fork($, prompt)
  } finally {
    forking = false
  }
  const s = await cli($, 'forked', { fork: forkResult(r) })
  if (s?.action === 'turn') return submit($, s.text)
  if (s?.action === 'none') return reschedule($, s.dueInSec)
  if (s?.action === 'retry' && timer === undefined && !answered) timer = $.clock.after(s.afterSec * 1000, () => void retryTick($))
}

async function compactLater($: $, instructions: string | undefined): Promise<void> {
  for (const ms of COMPACT_RETRY_MS) {
    await $.clock.sleep(ms)
    let result
    try {
      result = await $.session.compact(instructions === undefined ? {} : { instructions })
    } catch {
      continue
    }
    // WORKAROUND: the engine does not raise a plugin's own compaction in its own hooks (measured: "skipped:
    // re-entry"), so gate.ts never sees this one and `compacted` is reported from here.
    if (result?.skip === undefined) await cli($, 'compacted')
    return
  }
}

async function afterTurn($: $, claim: boolean): Promise<void> {
  if (claim) {
    const a = await cli($, 'arm')
    if (a?.action === 'none') schedule($, a.dueInSec)
  }
  if (compactAfterTurn) {
    const { instructions, at } = compactAfterTurn
    compactAfterTurn = undefined
    if ((await $.clock.now()) - at < COMPACT_AFTER_TURN_MS) await compactLater($, instructions)
  }
}

/** Run by gate.ts's `session.start` hook, after the engine started. */
export function keepaliveStarted($: $): void {
  $.clock.after(0, async () => {
    const a = await cli($, 'arm', { reload: true })
    if (a?.action === 'none') schedule($, a.dueInSec)
  })
}

/** Run by gate.ts's `turn.complete` hook, after the engine finished the turn. */
export function keepaliveTurnDone($: $, e: EventOf['turn.complete']): void {
  // INVARIANT: a turn ending under a fork in flight does not claim: the fork's own result re-arms.
  if (e.agentId === undefined) {
    answered = false
    $.clock.after(0, () => void afterTurn($, !forking))
  }
}

/** Run by gate.ts's `session.compact` hook once the engine compacted. */
export function keepaliveCompacted($: $, e: EventOf['session.compact'], result: EventResult<'session.compact'> | undefined): void {
  if (e.agentId !== undefined || e.trigger === 'precompute' || result?.skip !== undefined) return
  $.clock.after(0, () => void cli($, 'compacted'))
}

/** Run by gate.ts's `tool.call` hook as AskUserQuestion starts waiting for the person. */
export async function keepaliveWaitStart($: $): Promise<void> {
  answered = false
  const a = await cli($, 'wait-start')
  if (a?.action === 'none') schedule($, a.dueInSec)
}

/** Run when the answer came or the call failed: the turn goes on, and its Stop re-arms. */
export async function keepaliveWaitEnd($: $): Promise<void> {
  schedule($, undefined)
  answered = true
  await cli($, 'wait-end')
}

const PING_COMMAND = '/cache-keeper:ping'
const PING_MARKER = '[cache-keeper:ping]'

export function isPingTurn(text: string): boolean {
  const t = text.trim()
  if (t === PING_COMMAND || t.startsWith(`${PING_COMMAND} `)) return true
  // INVARIANT: the same test as src/commands.ts isPingCommand (the mod cannot import it). A command's turn begins with
  // its tag (seen on Claude Code 2.1.321); anchored at the start, so a message that merely quotes it is a message.
  return t.startsWith(PING_MARKER) || (t.startsWith('<command-') && t.includes(`<command-name>${PING_COMMAND}</command-name>`))
}

/** The text that answers `/cache-keeper:ping`'s turn, or undefined to let it reach the model as a wake turn. */
export async function manualPing($: $): Promise<string | undefined> {
  const a = await cli($, 'ping-now')
  if (a?.action === 'none') return a.text ?? 'cache-keeper: no ping sent.'
  if (a?.action !== 'fork') return undefined
  forking = true
  let r: ForkOutcome
  try {
    r = await fork($, a.prompt)
  } finally {
    forking = false
  }
  const s = await cli($, 'forked', { fork: forkResult(r) })
  if (s?.action === 'turn') return undefined
  if (s?.action === 'none' && s.text !== undefined) return s.text
  // INVARIANT: never a second request on top of a fork that went out, even when the CLI did not record it.
  return r.isAnswered ? 'cache-keeper: pinged, but keeper could not record it.' : 'cache-keeper: no ping sent: the fork failed.'
}

/** `{ skip }` while a renewing turn goes first. */
export async function beforeCompact($: $, e: EventOf['session.compact']): Promise<{ skip: string } | undefined> {
  if (e.agentId !== undefined || (e.trigger !== 'manual' && e.trigger !== 'plugin')) return undefined
  const a = await cli($, 'compact-check', { trigger: e.trigger })
  if (a?.action !== 'renew') return undefined
  const instructions = e.instructions
  compactAfterTurn = { instructions, at: await $.clock.now() }
  void $.prompt.submit({ text: a.text }).catch(() => {
    compactAfterTurn = undefined
    void compactLater($, instructions)
  })
  return {
    skip:
      'cache-keeper: one keep-alive turn first, so the compaction reads the warm cache ' +
      '(anthropics/claude-code#105017); it compacts right after.',
  }
}
