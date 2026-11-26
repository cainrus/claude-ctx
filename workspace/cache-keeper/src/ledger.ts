/** Every decision is one line appended to `$CACHE_KEEPER_HOME/ledger.jsonl`, which `cache-keeper report` reads. */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKIP_REASONS, type SkipReason } from './policy.ts'

/** Policy reasons, then `skip-if` (skipIf exit 0), `holder` (exit 3), `compacted` (nothing of the context cached). */
export const REFUSAL_REASONS = [...SKIP_REASONS, 'skip-if', 'holder', 'compacted'] as const
export type RefusalReason = SkipReason | 'skip-if' | 'holder' | 'compacted'

export const LEDGER_EVENTS = Object.freeze({
  ping: 'a ping went out; `pings` is its place in the idle stretch, `transport: "fork"` when it was a fork',
  skip: 'no ping; `reason` names the policy row that refused it (see [How it decides](policy.md))',
  resume: 'a real prompt ended an idle stretch that had pings; `pings` spent, `lastPingHit`; `detail: "question"` for an answer to a waiting question',
  'resume-paid': 'what the first request of that resumed turn really paid (`cacheRead`, `cacheWrite`)',
  'wake-hit': 'a ping read the cache; its usage is the cost line; `sentAt` is when it went out; `detail: "handoff"` for a brief turn',
  'wake-miss': 'a ping found the cache gone and wrote it again; mutes the session',
  'handoff-request': 'instead of letting the cache go, the brief turn was sent',
  'handoff-ready': 'the brief is on disk',
  'handoff-here': 'the menu was answered with continue here (`detail: "unattended"` in a background session)',
  'handoff-new': 'the menu was answered with a new session, and `spawnCommand` started it',
  'handoff-failed': 'no brief, or the new session did not start; `failure` says which step',
  done: '`/ctx:done`: no pings until the next real prompt',
  'fork-failed': 'a fork brought no reply; `failure` is its reason, `next` what follows (`retry`, `turn`, `drop`)',
  renew: 'a compaction after an hour held by forks alone was put off behind one wake turn',
  'manual-ping': '`/ctx:ping`; not scored, its cost is in the ping cost',
  error: 'a hook threw (errors.ts); `detail` is `<hook>: <message>`',
} as const)

export type LedgerEvent = keyof typeof LEDGER_EVENTS

export interface LedgerEntry {
  /** ISO timestamp. */
  t: string
  sessionId: string
  event: LedgerEvent
  reason?: RefusalReason
  ctxTokens?: number
  ageSec?: number
  model?: string
  /** resume: pings spent on the stretch that just ended. ping: this ping's position in its stretch (1-based). */
  pings?: number
  /** resume: whether the last ping of the stretch hit the cache (null = unknown). */
  lastPingHit?: boolean | null
  /** wake-hit / wake-miss: the wake turn's own usage. resume-paid: the resumed turn's first request. */
  inputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  outputTokens?: number
  /** ping / skip: keyboard idle seconds (null = unknown). */
  awaySeconds?: number | null
  /** ping / wake-hit / wake-miss: `fork` when the mod sent it as `$.model.fork`; absent = a wake turn. */
  transport?: 'fork'
  /** wake-hit / wake-miss, and manual-ping when it closed a wake turn (not a fork): ISO time the ping was sent, which is when the cache's clock restarted (`t` is when it was scored). */
  sentAt?: string
  /** handoff-failed: which step refused (no-brief, spawn). fork-failed: the fork's reason (nothing-to-fork, api-error, ...). */
  failure?: string
  /** fork-failed: what follows it: another fork, the wake turn, or nothing (too late to land warm). */
  next?: 'retry' | 'turn' | 'drop'
  detail?: string
}

export function ledgerPath(home: string): string {
  return join(home, 'ledger.jsonl')
}

export function appendLedger(home: string, entry: LedgerEntry): void {
  mkdirSync(home, { recursive: true })
  // INVARIANT: one small line per O_APPEND write, so concurrent hooks interleave whole lines.
  appendFileSync(ledgerPath(home), `${JSON.stringify(entry)}\n`)
}

export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.t === 'string' && typeof e.event === 'string' && typeof e.sessionId === 'string') out.push(e)
    } catch {
    }
  }
  return out
}

export function readLedger(home: string): LedgerEntry[] {
  try {
    return parseLedger(readFileSync(ledgerPath(home), 'utf8'))
  } catch {
    return []
  }
}
