/**
 * The AI Usage Barometer feed: the SwiftBar plugin reads the account's limits
 * from one JSON file instead of an API that answers 429 for hours under parallel
 * sessions. Schema 2, last writer wins, written whole by a rename. Turn it on
 * with `CTX_STATUSLINE_BAROMETER` (the file).
 */

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface BarometerLimit {
  kind: string
  percentUsed: number
  resetsAt?: string
}

function windowJson(limits: readonly BarometerLimit[], kind: string): { used_percentage: number | null; resets_at: number | null } | null {
  const l = limits.find((x) => x.kind === kind)
  if (l === undefined) return null
  const at = typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN
  return {
    used_percentage: Number.isFinite(l.percentUsed) ? l.percentUsed : null,
    resets_at: Number.isFinite(at) ? Math.floor(at / 1000) : null,
  }
}

export function barometerJson(capturedAt: number, sessionId: string | null, version: string | null, limits: readonly BarometerLimit[]): string {
  return JSON.stringify({
    schema_version: 2,
    source: 'claude-code-statusline',
    captured_at: capturedAt,
    session_id: sessionId,
    claude_code_version: version,
    five_hour_present: limits.some((l) => l.kind === 'five_hour'),
    seven_day_present: limits.some((l) => l.kind === 'seven_day'),
    five_hour: windowJson(limits, 'five_hour'),
    seven_day: windowJson(limits, 'seven_day'),
  })
}

/** The file whole or not at all: a reader never sees half of it. */
export function writeBarometer(file: string, text: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
  }
  const tmp = `${file}.${process.pid}`
  try {
    writeFileSync(tmp, `${text}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
