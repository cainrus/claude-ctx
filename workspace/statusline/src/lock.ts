/**
 * A lock between the processes of every session: a folder, made by whoever
 * takes it, stamped with when and by whom. Its holder keeps it for
 * milliseconds, so a lock a minute old is a dead holder's and is taken over;
 * a release frees only the holder's own lock.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A lock older than this is a dead holder's and is taken over. */
export const LOCK_MAX_AGE_SEC = 60
/** A takeover in progress older than this is a dead taker's. */
const TAKEOVER_MAX_AGE_SEC = 10

/** What `takeLock` hands back: the proof that frees it. */
export type LockToken = string

function make(lock: string, nowSec: number): LockToken | undefined {
  try {
    mkdirSync(lock)
  } catch {
    return undefined
  }
  const token = randomUUID()
  try {
    writeFileSync(join(lock, 'at'), `${nowSec} ${token}\n`)
    return token
  } catch {
    rmSync(lock, { recursive: true, force: true })
    return undefined
  }
}

const mtimeSec = (p: string): number | undefined => {
  try {
    return Math.floor(statSync(p).mtimeMs / 1000)
  } catch {
    return undefined
  }
}

function stampOf(lock: string): { at?: number; token?: string } {
  try {
    const [at, token] = readFileSync(join(lock, 'at'), 'utf8').trim().split(' ')
    if (at !== undefined && /^\d+$/.test(at)) return { at: Number(at), ...(token ? { token } : {}) }
  } catch {
    // No stamp yet.
  }
  // A holder between its mkdir and its write, or one that died there: the folder's own time.
  const at = mtimeSec(lock)
  return at === undefined ? {} : { at }
}

/**
 * mkdir is the atomic step. A stale lock is taken over under a second lock,
 * and the taker looks at its age again once it holds that: of two takers that
 * both saw it stale, the second finds the first one's fresh lock and leaves it.
 */
export function takeLock(lock: string, nowSec: number, maxAgeSec = LOCK_MAX_AGE_SEC): LockToken | undefined {
  const made = make(lock, nowSec)
  if (made !== undefined) return made
  const { at } = stampOf(lock)
  if (at === undefined || nowSec - at <= maxAgeSec) return undefined
  const takeover = `${lock}.takeover`
  try {
    mkdirSync(takeover)
  } catch {
    const since = mtimeSec(takeover)
    if (since !== undefined && nowSec - since > TAKEOVER_MAX_AGE_SEC) rmSync(takeover, { recursive: true, force: true })
    return undefined
  }
  try {
    const again = stampOf(lock).at
    if (again !== undefined && nowSec - again <= maxAgeSec) return undefined
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

/** Frees the lock if it is still the one `token` took: a holder taken over while it stalled frees nothing. */
export function releaseLock(lock: string, token: LockToken): void {
  if (stampOf(lock).token === token) rmSync(lock, { recursive: true, force: true })
}

/** Runs `fn` under the lock, waiting for it up to `waitMs`; past the wait it runs anyway, as it would with no lock at all. */
export function withLock<T>(lock: string, fn: () => T, waitMs = 2000): T {
  const until = Date.now() + waitMs
  const pause = new Int32Array(new SharedArrayBuffer(4))
  let token = takeLock(lock, Math.floor(Date.now() / 1000))
  while (token === undefined && Date.now() < until) {
    Atomics.wait(pause, 0, 0, 50)
    token = takeLock(lock, Math.floor(Date.now() / 1000))
  }
  try {
    return fn()
  } finally {
    if (token !== undefined) releaseLock(lock, token)
  }
}
