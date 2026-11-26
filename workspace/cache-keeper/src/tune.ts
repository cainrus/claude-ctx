/**
 * Moves `maxPings`, the pings per idle stretch, by the ledger, unless you set `maxPings` yourself. The k-th ping
 * is worth sending while you come back warm right after it more often than breakeven (wake cost / rewrite avoided,
 * both measured from the ledger). Once a day, with at least 30 pings at the cap's position in the last 60 days,
 * the cap goes up a step when that position kept 2× breakeven warm and down a step below breakeven, within [2, 8].
 * The decision is kept in `$CACHE_KEEPER_HOME/tuning.json`; `cache-keeper report` prints the cap and why.
 */

import { join } from 'node:path'
import type { Config } from './config.ts'
import { type LedgerEntry, readLedger } from './ledger.ts'
import { THRESHOLDS } from './policy.ts'
import { DEFAULT_PRICES, type PriceTable, promptOf, rateFor, requestUsd } from './prices.ts'
import { readJson, writeJsonAtomic } from './state.ts'

export const TUNE = Object.freeze({
  min: 2,
  max: 8,
  /** Pings sent at the cap's position before a step is taken. */
  minSamples: 30,
  /** Going up needs this many times breakeven. */
  raiseMargin: 2,
  /** Used until the ledger has a scored wake turn. */
  defaultBreakeven: 0.06,
  intervalMs: 24 * 3600_000,
  /** Only this much ledger history counts, so the cap follows how the machine is used now. */
  windowMs: 60 * 24 * 3600_000,
})

export interface PositionStats {
  /** Position of the ping in its idle stretch, 1-based. */
  k: number
  sent: number
  /** Stretches resumed while warm right after their k-th ping. */
  warm: number
}

export interface CapDecision {
  maxPings: number
  step: 'up' | 'down' | 'hold'
  /** Shown in the report. */
  why: string
}

export interface Tuning extends CapDecision {
  computedAt: number
  /** The cap this decision started from. */
  from: number
  breakeven: number
  stats: PositionStats[]
}

const tok = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

export function positionStats(entries: LedgerEntry[], cacheTtlSec: number): PositionStats[] {
  const sent = new Map<number, number>()
  const warm = new Map<number, number>()
  const open = new Map<string, number>()
  for (const e of entries) {
    if (e.event === 'ping') {
      const k = tok(e.pings) > 0 ? tok(e.pings) : (open.get(e.sessionId) ?? 0) + 1
      open.set(e.sessionId, k)
      sent.set(k, (sent.get(k) ?? 0) + 1)
    } else if (e.event === 'resume') {
      open.delete(e.sessionId)
      const k = tok(e.pings)
      const isWarm = typeof e.ageSec === 'number' && e.ageSec < cacheTtlSec && e.lastPingHit !== false
      if (k > 0 && isWarm) warm.set(k, (warm.get(k) ?? 0) + 1)
    }
  }
  return [...sent.keys()].sort((a, b) => a - b).map((k) => ({ k, sent: sent.get(k) ?? 0, warm: warm.get(k) ?? 0 }))
}

/** Mean of (wake turn cost / rewrite it avoids) over scored hits, each at its own model's rates. */
export function measuredBreakeven(entries: LedgerEntry[], prices: PriceTable = DEFAULT_PRICES): number {
  let sum = 0
  let n = 0
  for (const e of entries) {
    if (e.event !== 'wake-hit' || e.detail === 'handoff' || tok(e.ctxTokens) === 0) continue
    const r = rateFor(e.model, prices, promptOf(e))
    const avoided = (tok(e.ctxTokens) * (r.cacheWrite - r.cacheRead)) / 1e6
    if (avoided <= 0) continue
    sum += requestUsd(e, r) / avoided
    n++
  }
  return n > 0 ? sum / n : TUNE.defaultBreakeven
}

export function decideCap(current: number, stats: PositionStats[], breakeven: number): CapDecision {
  const cap = Math.min(TUNE.max, Math.max(TUNE.min, Math.round(current)))
  const at = stats.find((s) => s.k === cap)
  if (!at || at.sent < TUNE.minSamples) {
    return { maxPings: cap, step: 'hold', why: `ping ${cap}: ${at?.sent ?? 0} of ${TUNE.minSamples} samples` }
  }
  const rate = at.warm / at.sent
  const seen = `ping ${cap} kept ${pct(rate)} warm (${at.warm}/${at.sent}), breakeven ${pct(breakeven)}`
  if (rate >= breakeven * TUNE.raiseMargin && cap < TUNE.max) return { maxPings: cap + 1, step: 'up', why: seen }
  if (rate < breakeven && cap > TUNE.min) return { maxPings: cap - 1, step: 'down', why: seen }
  return { maxPings: cap, step: 'hold', why: seen }
}

export function tuningPath(home: string): string {
  return join(home, 'tuning.json')
}

export function loadTuning(home: string): Tuning | undefined {
  const t = readJson<Tuning>(tuningPath(home))
  return t && typeof t.maxPings === 'number' && typeof t.computedAt === 'number' ? t : undefined
}

/** The cap to use now; recomputed from the ledger at most once per `TUNE.intervalMs`. */
export function tunedMaxPings(config: Pick<Config, 'home' | 'cacheTtlSec'> & Partial<Pick<Config, 'prices'>>, now: number): number {
  const prev = loadTuning(config.home)
  if (prev && now - prev.computedAt < TUNE.intervalMs && now >= prev.computedAt) return prev.maxPings
  const since = now - TUNE.windowMs
  const entries = readLedger(config.home).filter((e) => Date.parse(e.t) >= since)
  const from = prev?.maxPings ?? THRESHOLDS.maxPings
  const breakeven = measuredBreakeven(entries, config.prices)
  const stats = positionStats(entries, config.cacheTtlSec)
  const next: Tuning = { ...decideCap(from, stats, breakeven), computedAt: now, from, breakeven, stats }
  try {
    writeJsonAtomic(tuningPath(config.home), next)
  } catch {
  }
  return next.maxPings
}
