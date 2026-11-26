/**
 * The gate: a `!` command, a built-in slash command and `/compact` reach the
 * model without the `UserPromptSubmit` hook, so they would hit a cold cache with
 * no menu. The gate asks keeper at the first model request of such a turn and
 * before a manual `/compact`, and stops the input just as a typed prompt would be
 * stopped: the menu when a handoff brief waits on a cold cache (`handoff.enabled`), the
 * cold stop (`coldStop.enabled`), or keeper's own answer to `/ctx:status`. A prompt the engine stamps as
 * the person's own (typed, or via Remote Control) is noted as `personAt` in `persons/<id>.json`, save a background
 * job's launch prompt, which the engine stamps as typed too. It runs
 * where Claude Code loads the plugin's mod; any failure lets the input through.
 */

import type { Chunk, EngineInterface, EventOf, EventResult, Register, StreamNext } from 'claude-code'
// WORKAROUND: Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and
// reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
// @ts-ignore TS5097
import { beforeCompact, cliArgv, isPingTurn, keepaliveCompacted, keepaliveStarted, keepaliveTurnDone, keepaliveWaitEnd, keepaliveWaitStart, manualPing } from './keepalive.ts'
// @ts-ignore TS5097
import { refresh, statusRequested, statusStarted, statusStepAnswered, statusTurnDone } from './status.ts'
// @ts-ignore TS5097
import { renderBand } from './band.ts'

const GATE_TIMEOUT_MS = 60_000

// As src/presence.ts GATE_TEXT_CHARS, which tells a launch prompt cut here by its head.
const HELD_CHARS = 4000

const PERSON_TIMEOUT_MS = 2_000

const PERSON_TEXT_CHARS = 16_000

// The origins the engine stamps as the person's own: Enter at the terminal, or Remote Control.
const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge']

let personChain: Promise<unknown> = Promise.resolve()

/** A prompt as submitted, or what became of the person prompt stamped `at`: it entered, or the gate refused it after that. */
type PersonWrite = { person: boolean; command: string | undefined; text: string } | { phase: 'entered' | 'refused'; at: number }

/** One write to `persons/<id>.json`, in order with every other; resolves to the prompt's stamp, undefined when it did not land. Never throws. */
export function recordPerson($: EngineInterface, write: PersonWrite): Promise<number | undefined> {
  const run = personChain.then(() => writePersonWithin($, write))
  personChain = run
  return run
}

// WARNING: the chain only advances when this settles, and every later prompt waits on it before next(e).
// The engine may ignore timeoutMs (or $.session.id / $.clock.now may never answer), so the module races the
// whole write against its own timer: a hung call costs at most PERSON_TIMEOUT_MS, not every later prompt.
async function writePersonWithin($: EngineInterface, write: PersonWrite): Promise<number | undefined> {
  let timer: { cancel: () => void } | undefined
  try {
    return await Promise.race([
      writePerson($, write),
      new Promise<undefined>(resolve => {
        timer = $.clock.after(PERSON_TIMEOUT_MS, () => resolve(undefined))
      }),
    ])
  } catch {
    return undefined
  } finally {
    timer?.cancel()
  }
}

async function writePerson($: EngineInterface, write: PersonWrite): Promise<number | undefined> {
  try {
    const sessionId = await $.session.id()
    const at = 'phase' in write ? write.at : await $.clock.now()
    // A head and the full length, not HELD_CHARS: `person` tells a background job's launch prompt apart by them, and a
    // huge paste on stdin would outlast PERSON_TIMEOUT_MS.
    const facts =
      'phase' in write
        ? { session_id: sessionId, at, phase: write.phase }
        : {
            session_id: sessionId,
            at,
            person: write.person,
            ...(write.command ? { command: write.command } : {}),
            // an image-only prompt may come with no text: the record is written all the same
            ...(write.person && typeof write.text === 'string' ? { text: write.text.slice(0, PERSON_TEXT_CHARS), text_length: write.text.length } : {}),
          }
    const { exitCode } = await $.process.run(cliArgv($, 'person'), { stdin: JSON.stringify(facts), timeoutMs: PERSON_TIMEOUT_MS })
    return exitCode === 0 ? at : undefined
  } catch {
    return undefined
  }
}

/** Every person write queued so far has settled: for tests. */
export function personWritesSettled(): Promise<unknown> {
  return personChain
}

/** A person prompt that starts a turn of its own: keeper's gate may still answer that turn itself (turn.step, session.compact). */
type OpenPrompt = { at: number; entered: boolean; refused: boolean; seenAt: number }

/** As src/commands.ts PROMPT_HOOK_GATE_MS: the longest from a prompt to its turn's first request. */
const OPEN_PROMPT_MS = 120_000

let openPrompt: OpenPrompt | undefined

// a prompt that started no turn (a local command) leaves its entry open: only its own turn's first request, within OPEN_PROMPT_MS, may take it
function takeOpenPrompt(): OpenPrompt | undefined {
  const p = openPrompt
  openPrompt = undefined
  return p && Date.now() - p.seenAt < OPEN_PROMPT_MS ? p : undefined
}

/** The gate answered the turn of the open prompt: it never reached the model, so it is not the person going on here. */
function refusePrompt($: EngineInterface, p: OpenPrompt | undefined): void {
  if (!p) return
  p.refused = true
  // WARNING: next(e) may not have resolved yet (the turn starts before it does); then the entered write sees `refused` and is never sent.
  if (p.entered) void recordPerson($, { phase: 'refused', at: p.at })
}

async function askGate($: EngineInterface, text: string, turn = false): Promise<string | undefined> {
  try {
    const sessionId = await $.session.id()
    const { exitCode, stdout } = await $.process.run(
      cliArgv($, 'gate'),
      { stdin: JSON.stringify({ session_id: sessionId, prompt: text.slice(0, HELD_CHARS), gate_turn: turn }), timeoutMs: GATE_TIMEOUT_MS },
    )
    if (exitCode !== 0 || stdout.trim() === '') return undefined
    const out = JSON.parse(stdout)
    return out.decision === 'block' && typeof out.reason === 'string' ? out.reason : undefined
  } catch {
    // INVARIANT: fail open: a timeout, a spawn failure or output that is not JSON lets the input through.
    return undefined
  }
}

/** keeper alone, as its tests load it; the claude-ctx plugin root registers the same hooks beside its other packages'. */
export const register: Register = on => {
  registerKeeperOwn(on)
  on('turn.start', ($, e, next) => {
    keeperTurnStarted(e)
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    return yield* keeperTurnStep($, e, next)
  })
}

const began = new Map<string, string>()

/** keeper's part of `turn.start`: the main turn's text, for the gate at its first request. */
export function keeperTurnStarted(e: { agentId?: string; turnId: string; text: string }): void {
  if (e.agentId === undefined) began.set(e.turnId, e.text)
}

// WORKAROUND: UserPromptSubmit never fires for a `!` command or a built-in slash command (measured on
// Claude Code 2.1.301), so they are gated here, at the turn's first model request; a refusal sends none.
/** keeper's `turn.step` body; the plugin's one `turn.step` hook delegates to it (`yield*`). */
export async function* keeperTurnStep($: EngineInterface, e: EventOf['turn.step'], next: StreamNext<'turn.step'>): AsyncGenerator<Chunk<'turn.step'>, EventResult<'turn.step'>> {
  if (e.agentId === undefined && e.index === 0) {
    const text = began.get(e.turnId) ?? ''
    began.delete(e.turnId)
    const reason = isPingTurn(text) ? await manualPing($) : await askGate($, text, true)
    const opened = takeOpenPrompt()
    if (reason !== undefined) {
      refusePrompt($, opened)
      yield { kind: 'text', index: 0, text: reason }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: reason, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  }
  if (e.agentId === undefined) await statusRequested($, e.turnId)
  const step = yield* next(e)
  if (e.agentId === undefined) statusStepAnswered(step?.usage)
  return step
}

/** keeper's hooks on the events no other package of the plugin hooks; `turn.start` and `turn.step` are registered by whoever loads it. */
export function registerKeeperOwn(on: Parameters<Register>[0]): void {
  // WARNING: a plugin loads one hooks module with one hook per event, so the fork pings (keepalive.ts)
  // and the status line (status.ts) are called from these hooks.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    statusStarted($)
    keepaliveStarted($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    keepaliveTurnDone($, e)
    statusTurnDone($)
    return done
  })

  // WARNING: recorded before next(e): a settings hook beneath may block the prompt, and the person still typed it;
  // awaited, and calls run on one promise chain (a failure never breaks it), so `persons/<id>.json` is single-writer
  // and its promptAt is on disk before the prompt reaches anyone.
  on('prompt.submit', async ($, e, next) => {
    const person = PERSON_ORIGINS.includes(e.origin?.kind ?? '')
    const at = await recordPerson($, { person, command: e.command?.name, text: e.text })
    // A prompt typed over a running turn is delivered into it: the gate never answers it. Any prompt that starts a
    // turn of its own replaces the open one, so a refusal of that turn never reaches back to an older prompt.
    const mine = person && at !== undefined ? { at, entered: false, refused: false, seenAt: Date.now() } : undefined
    if (e.turnId === undefined) openPrompt = mine
    const result = await next(e)
    const dropped = typeof result === 'object' && result !== null && 'drop' in result && result.drop !== undefined
    if (dropped && openPrompt === mine) openPrompt = undefined
    if (mine && !dropped && !mine.refused) {
      mine.entered = true
      void recordPerson($, { phase: 'entered', at: mine.at })
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => renderBand($, e, next, () => refresh($)))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await keepaliveWaitStart($)
    try {
      return await next(e)
    } finally {
      await keepaliveWaitEnd($)
    }
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'manual' && e.agentId === undefined) {
      const reason = await askGate($, '/compact')
      // the /compact prompt's own entry: taken either way, so no later turn can refuse it
      const opened = takeOpenPrompt()
      if (reason !== undefined) {
        refusePrompt($, opened)
        return { skip: reason }
      }
    }
    const renewFirst = await beforeCompact($, e)
    if (renewFirst !== undefined) return renewFirst
    const result = await next(e)
    keepaliveCompacted($, e, result)
    return result
  })
}
