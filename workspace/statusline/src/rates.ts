/**
 * The subscription-limit journal: one line per whole-point step of the
 * account's 5-hour and weekly usage, `<dir>/<account>.jsonl`, and the pair it
 * last wrote in `<account>.last`. Keyed by the config dir's name, never one
 * shared file: two profiles are two subscriptions. Each session sees only the
 * limits of its own last response, so a value is taken when its window is newer
 * or the same window went up; a stale reading changes nothing and writes nothing.
 * Turn it on with `CTX_STATUSLINE_RATE_DIR`.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from './lock.ts'

/** One window: whole percent used and when it resets, epoch seconds; null when unknown. */
export interface RateWindow {
  pct: number | null
  reset: number | null
}

export interface RatePair {
  five: RateWindow
  week: RateWindow
}

const EMPTY: RateWindow = { pct: null, reset: null }

/** The window to keep, and whether it moved: newer window, or the same one went up. */
export function mergeWindow(next: RateWindow, last: RateWindow): { window: RateWindow; moved: boolean } {
  if (next.pct === null) return { window: last, moved: false }
  if (last.pct === null) return { window: next, moved: true }
  if (next.reset !== null && last.reset !== null) {
    if (next.reset > last.reset) return { window: next, moved: true }
    if (next.reset < last.reset) return { window: last, moved: false }
  }
  if (next.pct > last.pct) return { window: { pct: next.pct, reset: next.reset ?? last.reset }, moved: true }
  return { window: last, moved: false }
}

const int = (s: string | undefined): number | null => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : null)

/** `.last`: `five|five_reset|week|week_reset`, empty for unknown. */
export function parseLast(text: string): RatePair {
  const [p5, r5, p7, r7] = text.trim().split('|')
  return { five: { pct: int(p5), reset: int(r5) }, week: { pct: int(p7), reset: int(r7) } }
}

export function lastText(p: RatePair): string {
  const s = (v: number | null) => (v === null ? '' : String(v))
  return `${s(p.five.pct)}|${s(p.five.reset)}|${s(p.week.pct)}|${s(p.week.reset)}\n`
}

export function journalLine(at: number, session: string, p: RatePair): string {
  return `${JSON.stringify({ at, session, five: p.five.pct, five_reset: p.five.reset, week: p.week.pct, week_reset: p.week.reset })}\n`
}

/** The engine's reading (`percentUsed`, ISO `resetsAt`) as the journal keeps it: whole percent, epoch seconds. */
export function windowOf(limit: { percentUsed?: unknown; resetsAt?: unknown } | undefined): RateWindow {
  if (!limit || typeof limit.percentUsed !== 'number' || !Number.isFinite(limit.percentUsed)) return EMPTY
  const at = typeof limit.resetsAt === 'string' ? Date.parse(limit.resetsAt) : NaN
  return { pct: Math.round(limit.percentUsed), reset: Number.isFinite(at) ? Math.floor(at / 1000) : null }
}

/** Merges `next` into the account's journal; true when it appended a line. */
export function recordRates(dir: string, account: string, session: string, at: number, next: RatePair): boolean {
  if (next.five.pct === null && next.week.pct === null) return false
  mkdirSync(dir, { recursive: true })
  // Two sessions of one account reading one new step in the same moment would both append it: one at a time.
  // A holder keeps the lock for milliseconds: a dead one's is taken over past 4 s (about 5 on whole seconds), a dead
  // taker's leftover cleared past 3 s (about 4), so either usually inside the 6 s wait. Past the wait the step is
  // written anyway: at worst a duplicate line (readers take the last line, or count rises only), never a lost step.
  return withLock(join(dir, `${account}.lock`), () => appendStep(dir, account, session, at, next), 6000, 4)
}

function appendStep(dir: string, account: string, session: string, at: number, next: RatePair): boolean {
  const lastPath = join(dir, `${account}.last`)
  let last: RatePair = { five: EMPTY, week: EMPTY }
  try {
    last = parseLast(readFileSync(lastPath, 'utf8'))
  } catch {
    // No journal yet: every known window is a step.
  }
  const five = mergeWindow(next.five, last.five)
  const week = mergeWindow(next.week, last.week)
  if (!five.moved && !week.moved) return false
  const pair = { five: five.window, week: week.window }
  appendFileSync(join(dir, `${account}.jsonl`), journalLine(at, session, pair))
  const tmp = `${lastPath}.${process.pid}`
  try {
    writeFileSync(tmp, lastText(pair))
    renameSync(tmp, lastPath)
  } finally {
    rmSync(tmp, { force: true })
  }
  return true
}
