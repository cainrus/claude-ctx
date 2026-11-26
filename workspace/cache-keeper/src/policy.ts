/**
 * Decides whether an idle session gets a ping now. The first matching row refuses it and names the ledger reason:
 * `done` (you ran /cache-keeper:done), `away` (idle past `awaySec`), `away-budget-spent` (not at the keyboard and
 * the machine-wide `maxAwayPings` spent), `context-too-small` (below `minCtxTokens`), `cache-expired` (older than
 * `maxAgeSec`), `cache-still-warm` (younger than `minAgeSec`), `budget-spent` (`maxPings` used this idle stretch),
 * `oracle-miss` (the previous ping missed the cache). Tune each row with its config key; `enabled: false` stops all.
 */

export interface Thresholds {
  /** Keyboard/mouse idle longer than this: the human is gone, let the cache go. */
  awaySec: number
  /** Idle up to this counts as at the keyboard; beyond it pings are paid from the away budget. */
  presenceSec: number
  /** Pings the whole machine may spend on one absence; refilled by presence. */
  maxAwayPings: number
  /** Contexts smaller than this are cheap to rebuild and not worth holding. */
  minCtxTokens: number
  /** Cache younger than this is still warm: nothing to do yet. */
  minAgeSec: number
  /** Cache older than this may already be gone; a ping would pay a full rewrite. */
  maxAgeSec: number
  /** Pings per idle stretch of one session, reset only by a real prompt. */
  maxPings: number
}

export const THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  awaySec: 1200,
  presenceSec: 300,
  maxAwayPings: 6,
  minCtxTokens: 20_000,
  minAgeSec: 50 * 60,
  maxAgeSec: 58 * 60,
  maxPings: 4,
})

export interface PolicyInput {
  /** Seconds since the last keyboard/mouse event; null when the probe could not answer. */
  awaySeconds: number | null
  /** Seconds since the cache was last touched (a real turn or a landed ping). */
  ageSec: number
  /** Size of the cached prefix, tokens. */
  ctxTokens: number
  pingsSoFar: number
  /** Pings spent by every session on this machine since presence was last seen. */
  awayPingsSincePresence: number
  /** Did the previous ping read the cache (true) or rewrite it (false)? null = no ping yet. */
  lastPingHit: boolean | null
  /** Set by `/cache-keeper:done`; cleared by the next real prompt. */
  muted?: boolean
}

/** Refusal reasons, in the order `decide` checks them. */
export const SKIP_REASONS = [
  'done',
  'away',
  'away-budget-spent',
  'context-too-small',
  'cache-expired',
  'cache-still-warm',
  'budget-spent',
  'oracle-miss',
] as const

export type SkipReason = (typeof SKIP_REASONS)[number]

export type Decision = { ping: true } | { ping: false; reason: SkipReason }

export function isAtKeyboard(awaySeconds: number | null, t: Thresholds = THRESHOLDS): boolean {
  // INVARIANT: null (an unknown probe) is neither at the keyboard nor gone: read as present, a broken probe would
  // lift the away budget, the only machine-wide cap.
  return awaySeconds !== null && awaySeconds <= t.presenceSec
}

export function decide(s: PolicyInput, t: Thresholds = THRESHOLDS): Decision {
  // INVARIANT: branch order is the policy and must match SKIP_REASONS: it decides which reason the ledger blames.
  if (s.muted === true) return { ping: false, reason: 'done' }

  const goneForGood = s.awaySeconds !== null && s.awaySeconds > t.awaySec
  if (goneForGood) return { ping: false, reason: 'away' }

  if (!isAtKeyboard(s.awaySeconds, t) && s.awayPingsSincePresence >= t.maxAwayPings) {
    return { ping: false, reason: 'away-budget-spent' }
  }

  if (s.ctxTokens < t.minCtxTokens) return { ping: false, reason: 'context-too-small' }
  if (s.ageSec >= t.maxAgeSec) return { ping: false, reason: 'cache-expired' }
  if (s.ageSec < t.minAgeSec) return { ping: false, reason: 'cache-still-warm' }
  if (s.pingsSoFar >= t.maxPings) return { ping: false, reason: 'budget-spent' }
  if (s.lastPingHit === false) return { ping: false, reason: 'oracle-miss' }
  return { ping: true }
}
