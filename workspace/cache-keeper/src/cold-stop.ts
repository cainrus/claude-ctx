/**
 * The cold stop: a prompt into a session whose cache has gone cold is more often sent by accident than on
 * purpose, and its turn re-sends the whole context. So the first such prompt is held before it reaches the
 * model, with what going on costs; anything sent within `coldStop.ackSec` of the stop goes through. Where the
 * plugin's mod loads, a slash command and `/compact` are held the same way. A background session is held too:
 * only a machine's prompt passes. Never held: a warm session, one with no turn yet, a turn that would cost less
 * than `coldStop.minUsd`, keeper's own commands and those in `coldStop.passCommands`, a peer's or a plugin's
 * message, a task notification, keeper's wake, a background job's launch prompt. A handoff brief's menu, when
 * one is ready, answers instead. Off by default: `coldStop.enabled` or `CTX_KEEPER_COLD_STOP=1`.
 *
 * `coldStop.blockIf` (env `CTX_KEEPER_BLOCK_IF`): your shell command, asked first on every prompt a person may
 * have typed (never a machine's), warm or cold, for a stop only your tooling knows (the work went to another
 * session). It reads the facts as JSON on stdin (`session_id`, `transcript_path`, `prompt` up to 16,000
 * characters, `cold`, and `coldLines` when keeper would stop this prompt) and gets `CTX_KEEPER_SESSION_ID`,
 * `CTX_KEEPER_TRANSCRIPT_PATH`. Exit 2 stops the prompt with its stdout as the reason; put `coldLines` in it,
 * or keeper still owes its own stop. Exit 3 lets it through past keeper's stops (once the price was shown), its
 * stdout (if any) going to the model as context. Any other exit, a missing command or a timeout (3 s) leaves
 * the prompt to keeper.
 */

import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { coldRewriteUsd, idleText, isMachineMessage } from './handoff.ts'
import { appendLedger } from './ledger.ts'
import { isJobLaunchPrompt } from './presence.ts'
import type { SessionState } from './state.ts'
import { lastMainUsage } from './transcript.ts'
import { readWarmth } from './warmth.ts'

export const BLOCK_IF_TIMEOUT_MS = 3000
export const BLOCK_IF_STOP_EXIT = 2
export const BLOCK_IF_PASS_EXIT = 3

/** How much of the prompt `blockIf` reads: enough to tell a command or an envelope, small enough for any pipe. */
export const BLOCK_IF_PROMPT_CHARS = 16_000

/** What the `blockIf` command reads on stdin. */
export interface BlockIfInput {
  session_id: string
  transcript_path?: string
  prompt: string
  cold: boolean
  /** keeper's stop text, line by line, when it would stop this prompt itself. */
  coldLines?: string[]
}

export type BlockIfAnswer = { kind: 'none' } | { kind: 'stop'; reason: string } | { kind: 'pass'; context?: string }

export function runBlockIf(command: string, input: BlockIfInput, timeoutMs = BLOCK_IF_TIMEOUT_MS): BlockIfAnswer {
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'cache-keeper-block-if-'))
    const outPath = join(dir, 'out')
    const out = openSync(outPath, 'w')
    let r: ReturnType<typeof spawnSync>
    try {
      // WARNING: stdout goes to a file, not a pipe: a grandchild that keeps a pipe open (`curl … | jq`) holds spawnSync past its
      // timeout until the hook itself is killed, which lets the prompt through and lifts keeper's stop.
      r = spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, CTX_KEEPER_SESSION_ID: input.session_id, CTX_KEEPER_TRANSCRIPT_PATH: input.transcript_path ?? '' },
        input: JSON.stringify({ ...input, prompt: input.prompt.slice(0, BLOCK_IF_PROMPT_CHARS) }),
        stdio: ['pipe', out, 'ignore'],
        timeout: timeoutMs,
        // a command that traps SIGTERM would hold spawnSync past the timeout, and the hook with it
        killSignal: 'SIGKILL',
      })
    } finally {
      closeSync(out)
    }
    // WARNING: a command that exits without reading stdin leaves EPIPE in r.error beside a real exit status; only an error with no status is no answer.
    if (r.error !== undefined && ((r.error as NodeJS.ErrnoException).code !== 'EPIPE' || r.status === null)) return { kind: 'none' }
    const text = readFileSync(outPath, 'utf8').trim()
    if (r.status === BLOCK_IF_STOP_EXIT && text !== '') return { kind: 'stop', reason: text }
    if (r.status === BLOCK_IF_PASS_EXIT) return text === '' ? { kind: 'pass' } : { kind: 'pass', context: text }
    return { kind: 'none' }
  } catch {
    return { kind: 'none' }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

export type ColdStopVerdict = { kind: 'block'; reason: string } | { kind: 'pass'; context?: string }

const RELAYED = [/^\s*Another Claude session sent a message:/, /^\s*The .{1,60} plugin sent a message:/]

// keeper's own wake, and the envelopes the engine itself wraps a non-person prompt in; a person's `[wip-fix] …`,
// `[Image #1]` or pasted `<my-component>` is none of them
const MACHINE_TAG = /^(?:\[cache-keeper[\]:]|<(?:local-command-[a-z]+|system-reminder|teammate-message|channel-message)[\s>])/

/** A prompt no person typed into this session's input box. */
export function isMachinePrompt(prompt: string, env: NodeJS.ProcessEnv, maybeCut = false): boolean {
  const p = prompt.trimStart()
  // INVARIANT: never held, by keeper or by blockIf: nobody resends a machine's prompt, and its sender reads "delivered".
  return p === '' || isMachineMessage(p) || RELAYED.some((re) => re.test(p)) || MACHINE_TAG.test(p) || isJobLaunchPrompt(prompt, env, undefined, maybeCut)
}

/** The slash command a prompt runs, without the slash: typed (`/name args`) or as the engine tags it; a path is none. */
export function slashCommandOf(prompt: string): string | undefined {
  const tagged = /<command-name>\/?([\w.:-]+)<\/command-name>/.exec(prompt)
  if (tagged && prompt.trimStart().startsWith('<command-')) return tagged[1]
  return /^\s*\/([\w.:-]+)(?:\s|$)/.exec(prompt)?.[1]
}

/** A slash command the person means to run on a cold cache: keeper's own, or one of `coldStop.passCommands`. */
function isPassCommand(prompt: string, passCommands: readonly string[]): boolean {
  const command = slashCommandOf(prompt)
  if (command === undefined) return false
  const name = command.split(':').at(-1) ?? command
  return command.startsWith('ctx:') || passCommands.includes(command) || passCommands.includes(name)
}

/** What the stop knows of one prompt, read once for blockIf and for keeper. */
export interface ColdFacts {
  cold: boolean
  /** A stop was held within `ackSec`: its price was shown. */
  acked: boolean
  /** keeper's stop text when it would hold this prompt; undefined when it would not. */
  lines?: string[]
}

export function coldFacts(prompt: string, state: SessionState, config: Config, now: number, gate: boolean): ColdFacts {
  const cs = config.coldStop
  const warmth = readWarmth(config.home, state.sessionId, now, state.transcriptPath, config.cacheTtlSec)
  const cold = warmth.cold
  // the ack answers the stop, not the hours after it: a turn that ended since renewed the cache, and the next cold prompt is a new one
  const acked = state.coldStopAt !== undefined && now - state.coldStopAt < cs.ackSec * 1000 && (state.lastTurnEndAt ?? 0) < state.coldStopAt
  if (!cs.enabled || !cold || acked || isPassCommand(prompt, cs.passCommands)) return { cold, acked }
  // a session resumed after SessionEnd has a fresh record: its size is in the transcript it resumes
  const last = state.ctxTokens > 0 || !state.transcriptPath ? undefined : lastMainUsage(state.transcriptPath)
  const ctxTokens = state.ctxTokens > 0 ? state.ctxTokens : (last?.ctxTokens ?? 0)
  const usd = state.ctxTokens > 0 && state.coldTurnUsd !== undefined ? state.coldTurnUsd : coldRewriteUsd(ctxTokens, state.model ?? last?.model, config)
  if (!(ctxTokens > 0) || usd < cs.minUsd) return { cold, acked }
  const fresh = state.coldStartUsd !== undefined && state.coldStartUsd < usd ? `; a new session's first turn ≈ $${state.coldStartUsd.toFixed(2)}` : ''
  const window = cs.ackSec < 120 ? `${Math.round(cs.ackSec)} s` : `${Math.floor(cs.ackSec / 60)} min`
  const lines = [
    `cache-keeper: this session's prompt cache has gone cold (idle ${idleText(now - warmth.lastWarmAt!)}): this ${gate ? 'command' : 'prompt'} was NOT sent.`,
    `Its turn would re-send ~${Math.round(ctxTokens / 1000)}k tokens (≈ $${usd.toFixed(2)})${fresh}.`,
    `Go on here anyway: ${gate ? 'run it' : 'send it'} again within ${window}.${cs.hint ? ` ${cs.hint}` : ''}`,
  ]
  return { cold, acked, lines }
}

/**
 * The `blockIf` command's answer, asked before keeper changes anything (the handoff menu marks its brief used):
 * a block it holds, a pass that skips keeper's stops, or undefined for keeper to decide.
 */
export function askBlockIf(prompt: string, state: SessionState, config: Config, now: number, facts: ColdFacts, blockIf: (input: BlockIfInput) => BlockIfAnswer): ColdStopVerdict | undefined {
  const answer = blockIf({
    session_id: state.sessionId,
    ...(state.transcriptPath ? { transcript_path: state.transcriptPath } : {}),
    prompt,
    cold: facts.cold,
    ...(facts.lines ? { coldLines: facts.lines } : {}),
  })
  if (answer.kind === 'stop') {
    // the price counts as shown only when the reason carries it; else the resend still owes keeper's stop
    if (facts.lines && answer.reason.includes(facts.lines[0])) state.coldStopAt = now
    if (facts.cold) appendLedger(config.home, { t: new Date(now).toISOString(), sessionId: state.sessionId, event: 'cold-stop', detail: 'block-if', ctxTokens: state.ctxTokens, model: state.model })
    return { kind: 'block', reason: answer.reason }
  }
  // INVARIANT: a pass never skips a price nobody showed: with keeper's stop due, keeper decides (the menu too, see touch).
  if (answer.kind === 'pass' && facts.lines === undefined) {
    if (facts.acked && facts.cold && (state.lastHumanAt ?? 0) < (state.coldStopAt ?? 0)) {
      appendLedger(config.home, { t: new Date(now).toISOString(), sessionId: state.sessionId, event: 'cold-go-on', ctxTokens: state.ctxTokens, model: state.model })
    }
    return answer.context === undefined ? { kind: 'pass' } : { kind: 'pass', context: answer.context }
  }
  return undefined
}

/** keeper's own stop, for a prompt no handoff menu and no blockIf answered: undefined = let it through. */
export function keeperColdStop(state: SessionState, config: Config, now: number, facts: ColdFacts, gate: boolean): ColdStopVerdict | undefined {
  const t = new Date(now).toISOString()
  if (facts.lines) {
    state.coldStopAt = now
    appendLedger(config.home, { t, sessionId: state.sessionId, event: 'cold-stop', ctxTokens: state.ctxTokens, model: state.model })
    return { kind: 'block', reason: facts.lines.join('\n') }
  }
  // WARNING: the ack stays for its whole window: the gate's ask and a follow-up typed while the resent turn runs still read cold.
  // once per stop: the first prompt through after it (touch moves lastHumanAt past the stop), not each follow-up
  if (facts.acked && facts.cold && !gate && (state.lastHumanAt ?? 0) < (state.coldStopAt ?? 0)) appendLedger(config.home, { t, sessionId: state.sessionId, event: 'cold-go-on', ctxTokens: state.ctxTokens, model: state.model })
  return undefined
}
