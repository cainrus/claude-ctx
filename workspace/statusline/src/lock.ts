/** A lock between the processes of every session: a folder, made by whoever takes it. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A lock older than this is a dead holder's and is taken over. */
export const LOCK_MAX_AGE_SEC = 60

function make(lock: string, nowSec: number): boolean {
  try {
    mkdirSync(lock)
  } catch {
    return false
  }
  writeFileSync(join(lock, 'at'), `${nowSec}\n`)
  return true
}

/** mkdir is the atomic step; a stale lock is renamed away first, so of two takers only one moves it. */
export function takeLock(lock: string, nowSec: number): boolean {
  if (make(lock, nowSec)) return true
  let at = NaN
  try {
    at = Number(readFileSync(join(lock, 'at'), 'utf8').trim())
  } catch {
    // WARNING: no stamp yet means the holder sits between its mkdir and its write; stamp it so a holder that died there still ages out.
    try {
      writeFileSync(join(lock, 'at'), `${nowSec}\n`, { flag: 'wx' })
    } catch {
      // Someone stamped it first, or the lock went away.
    }
    return false
  }
  if (Number.isFinite(at) && nowSec - at <= LOCK_MAX_AGE_SEC) return false
  const away = `${lock}.stale.${process.pid}`
  try {
    renameSync(lock, away)
  } catch {
    return false
  }
  rmSync(away, { recursive: true, force: true })
  return make(lock, nowSec)
}

export function releaseLock(lock: string): void {
  rmSync(lock, { recursive: true, force: true })
}

/** Runs `fn` under the lock, waiting for it up to `waitMs`; undefined when it never came free. */
export function withLock<T>(lock: string, fn: () => T, waitMs = 2000): T | undefined {
  const until = Date.now() + waitMs
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (!takeLock(lock, Math.floor(Date.now() / 1000))) {
    if (Date.now() >= until) return undefined
    Atomics.wait(pause, 0, 0, 50)
  }
  try {
    return fn()
  } finally {
    releaseLock(lock)
  }
}
