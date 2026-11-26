/** A lock between the processes of every session: a folder, made by whoever takes it. */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A lock older than this is a dead holder's and is taken over. */
export const LOCK_MAX_AGE_SEC = 60
/** A takeover in progress older than this is a dead taker's. */
const TAKEOVER_MAX_AGE_MS = 10_000

function make(lock: string, nowSec: number): boolean {
  try {
    mkdirSync(lock)
  } catch {
    return false
  }
  try {
    writeFileSync(join(lock, 'at'), `${nowSec}\n`)
    return true
  } catch {
    rmSync(lock, { recursive: true, force: true })
    return false
  }
}

const mtimeSec = (p: string): number | undefined => {
  try {
    return Math.floor(statSync(p).mtimeMs / 1000)
  } catch {
    return undefined
  }
}

/** When the lock was taken: its stamp, else (a holder between its mkdir and its write, or one that died there) its folder's time. */
function takenAt(lock: string): number | undefined {
  try {
    const text = readFileSync(join(lock, 'at'), 'utf8').trim()
    if (/^\d+$/.test(text)) return Number(text)
  } catch {
    // No stamp yet.
  }
  return mtimeSec(lock)
}

/**
 * mkdir is the atomic step. A stale lock is taken over under a second lock,
 * and the taker looks at its age again once it holds that: of two takers that
 * both saw it stale, the second finds the first one's fresh lock and leaves it.
 */
export function takeLock(lock: string, nowSec: number, maxAgeSec = LOCK_MAX_AGE_SEC): boolean {
  if (make(lock, nowSec)) return true
  const at = takenAt(lock)
  if (at === undefined || nowSec - at <= maxAgeSec) return false
  const takeover = `${lock}.takeover`
  try {
    mkdirSync(takeover)
  } catch {
    const since = mtimeSec(takeover)
    if (since !== undefined && Date.now() / 1000 - since > TAKEOVER_MAX_AGE_MS / 1000) rmSync(takeover, { recursive: true, force: true })
    return false
  }
  try {
    const again = takenAt(lock)
    if (again !== undefined && nowSec - again <= maxAgeSec) return false
    const away = `${lock}.stale.${process.pid}`
    try {
      renameSync(lock, away)
      rmSync(away, { recursive: true, force: true })
    } catch {
      // Gone already: free to make.
    }
    return make(lock, nowSec)
  } finally {
    rmSync(takeover, { recursive: true, force: true })
  }
}

export function releaseLock(lock: string): void {
  rmSync(lock, { recursive: true, force: true })
}

/** Runs `fn` under the lock, waiting for it up to `waitMs`; undefined when it never came free. */
export function withLock<T>(lock: string, fn: () => T, opts: { waitMs?: number; maxAgeSec?: number } = {}): T | undefined {
  const until = Date.now() + (opts.waitMs ?? 2000)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (!takeLock(lock, Math.floor(Date.now() / 1000), opts.maxAgeSec)) {
    if (Date.now() >= until) return undefined
    Atomics.wait(pause, 0, 0, 50)
  }
  try {
    return fn()
  } finally {
    releaseLock(lock)
  }
}
