/**
 * The gate: a `!` command, a built-in slash command and `/compact` reach the
 * model without the `UserPromptSubmit` hook, so they would hit a cold cache with
 * no menu. The gate asks keeper at the first model request of such a turn and
 * before a manual `/compact`, and stops the input just as a typed prompt would be
 * stopped: the menu when a handoff brief waits on a cold cache (`handoff.enabled`),
 * or keeper's own answer to `/cache-keeper:status`. It runs where Claude Code
 * loads the plugin's mod; any failure lets the input through.
 */

import type { EngineInterface, Register } from 'claude-code'
// WORKAROUND: Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and
// reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
// @ts-ignore TS5097
import { beforeCompact, isPingTurn, keepaliveCompacted, keepaliveStarted, keepaliveTurnDone, keepaliveWaitEnd, keepaliveWaitStart, manualPing } from './keepalive.ts'
// @ts-ignore TS5097
import { refresh, statusRequested, statusStarted, statusTurnDone } from './status.ts'
// @ts-ignore TS5097
import { renderBand } from './band.ts'

const GATE_TIMEOUT_MS = 60_000

const HELD_CHARS = 4000

async function askGate($: EngineInterface, text: string, turn = false): Promise<string | undefined> {
  try {
    const sessionId = await $.session.id()
    const { exitCode, stdout } = await $.process.run(
      ['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/bin/cache-keeper.ts`, 'gate'],
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

export const register: Register = on => {
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

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => renderBand($, e, next, () => refresh($)))

  const began = new Map<string, string>()

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) began.set(e.turnId, e.text)
    return next(e)
  })

  // WORKAROUND: UserPromptSubmit never fires for a `!` command or a built-in slash command (measured on
  // Claude Code 2.1.301), so they are gated here, at the turn's first model request; a refusal sends none.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.index === 0) {
      const text = began.get(e.turnId) ?? ''
      began.delete(e.turnId)
      const reason = isPingTurn(text) ? await manualPing($) : await askGate($, text, true)
      if (reason !== undefined) {
        yield { kind: 'text', index: 0, text: reason }
        yield { kind: 'stop', stopReason: 'end_turn', usage: null }
        return { turnId: e.turnId, index: e.index, answer: reason, toolUses: [], stopReason: 'end_turn', usage: null }
      }
    }
    if (e.agentId === undefined) void statusRequested($)
    return yield* next(e)
  })

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
      if (reason !== undefined) return { skip: reason }
    }
    const renewFirst = await beforeCompact($, e)
    if (renewFirst !== undefined) return renewFirst
    const result = await next(e)
    keepaliveCompacted($, e, result)
    return result
  })
}
