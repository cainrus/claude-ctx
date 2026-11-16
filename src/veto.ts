/**
 * `skipIf` (env `CACHE_KEEPER_SKIP_IF`): your shell command, run through `/bin/sh` before a ping or a due handoff
 * that passed every other row, for what only your tooling knows: the task is finished, handed off, a batch job.
 * It gets `CACHE_KEEPER_SESSION_ID`, `CACHE_KEEPER_TRANSCRIPT_PATH` and `CACHE_KEEPER_LAST_PROMPT_AT` (ISO).
 * Exit 0 skips the ping. Exit 3 means someone else holds the session and would rather continue in a new one:
 * no ping, and a handoff when one is due. Any other exit, a missing command or a timeout (5 s) lets the ping out.
 * Unset it to turn the veto off.
 */

import { spawnSync } from 'node:child_process'

export interface SessionFacts {
  sessionId: string
  transcriptPath?: string
  /** Epoch ms of the last real (non-wake) prompt. */
  lastPromptAt?: number
}

/** What the `skipIf` command answered. */
export type Verdict = 'ping' | 'skip' | 'handoff'

export const SKIP_IF_TIMEOUT_MS = 5000
export const HANDOFF_EXIT = 3

export function runSkipIf(command: string, facts: SessionFacts, timeoutMs = SKIP_IF_TIMEOUT_MS): Verdict {
  const r = spawnSync('/bin/sh', ['-c', command], {
    env: {
      ...process.env,
      CACHE_KEEPER_SESSION_ID: facts.sessionId,
      CACHE_KEEPER_TRANSCRIPT_PATH: facts.transcriptPath ?? '',
      CACHE_KEEPER_LAST_PROMPT_AT: facts.lastPromptAt !== undefined ? new Date(facts.lastPromptAt).toISOString() : '',
    },
    stdio: 'ignore',
    timeout: timeoutMs,
  })
  if (r.error !== undefined) return 'ping'
  if (r.status === 0) return 'skip'
  if (r.status === HANDOFF_EXIT) return 'handoff'
  return 'ping'
}
