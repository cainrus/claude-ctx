/**
 * The background refresh of one checkout's counts (hooks/gitfacts.ts reads
 * them): one process per checkout under a lock taken before the work starts,
 * each git call on a time budget, and a call that fails or runs over keeps the
 * previous value. The epoch moves either way: a slow repo is retried once per
 * TTL, not at every look.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// @ts-ignore TS5097
import { countsText, parseCounts, passDue, type GitCounts } from '../hooks/gitfacts.ts'

/** Seconds a git call may take. */
export const GIT_BUDGET_SEC = 10
/** A lock older than this is a dead refresher and is taken over. */
export const LOCK_MAX_AGE_SEC = 60

/** mkdir is the atomic step: whoever creates the folder refreshes. */
export function takeLock(lock: string, nowSec: number): boolean {
  try {
    mkdirSync(lock)
    writeFileSync(join(lock, 'at'), `${nowSec}\n`)
    return true
  } catch {
    // Held: by a live refresher, or a dead one past its age.
  }
  let at = NaN
  try {
    at = Number(readFileSync(join(lock, 'at'), 'utf8').trim())
  } catch {
    // WARNING: no stamp yet means the holder sits between its mkdir and its write; stamp it so a holder that died there still ages out.
    try {
      writeFileSync(join(lock, 'at'), `${nowSec}\n`, { flag: 'wx' })
    } catch {
      // Someone stamped it first.
    }
    return false
  }
  if (Number.isFinite(at) && nowSec - at <= LOCK_MAX_AGE_SEC) return false
  rmSync(lock, { recursive: true, force: true })
  try {
    mkdirSync(lock)
    writeFileSync(join(lock, 'at'), `${nowSec}\n`)
    return true
  } catch {
    return false
  }
}

const mtimeSec = (p: string): number => {
  try {
    return statSync(p).mtimeMs / 1000
  } catch {
    return 0
  }
}

function git(workdir: string, args: string[]): { ok: boolean; timedOut: boolean; out: string } {
  // `--no-optional-locks`: a plain status rewrites the index, which would move its mtime, look like a change and loop.
  const r = spawnSync('git', ['-C', workdir, '--no-optional-locks', ...args], { encoding: 'utf8', timeout: GIT_BUDGET_SEC * 1000 })
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  return { ok: r.status === 0, timedOut, out: r.stdout ?? '' }
}

/** Runs the pass that is due, if any, and writes the counts; false when another process holds the checkout or nothing was due. */
export function refreshCounts(workdir: string, gitDir: string, cacheFile: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  let before: GitCounts = { fastAt: 0, fullAt: 0 }
  try {
    before = parseCounts(readFileSync(cacheFile, 'utf8'))
  } catch {
    // Never counted.
  }
  const cachedAt = mtimeSec(cacheFile)
  const moved = mtimeSec(join(gitDir, 'index')) > cachedAt || mtimeSec(join(gitDir, 'HEAD')) > cachedAt
  const pass = passDue(before, nowSec, moved)
  if (pass === undefined) return false
  mkdirSync(dirname(cacheFile), { recursive: true })
  const lock = `${cacheFile}.lock`
  if (!takeLock(lock, nowSec)) return false
  try {
    const next: GitCounts = { ...before }
    const status = git(workdir, ['status', '--porcelain', `--untracked-files=${pass === 'full' ? 'normal' : 'no'}`])
    if (status.ok) {
      const lines = status.out.split('\n').filter((l) => l !== '')
      next.tracked = lines.filter((l) => !l.startsWith('??')).length
      if (pass === 'full') next.untracked = lines.length - next.tracked
    }
    if (pass === 'full') next.fullAt = Math.floor(Date.now() / 1000)
    const ahead = git(workdir, ['rev-list', '--count', '@{u}..HEAD'])
    if (ahead.ok && /^\d+$/.test(ahead.out.trim())) next.ahead = Number(ahead.out.trim())
    else if (!ahead.timedOut) next.ahead = undefined
    next.fastAt = Math.floor(Date.now() / 1000)
    const tmp = `${cacheFile}.${process.pid}`
    writeFileSync(tmp, countsText(next))
    renameSync(tmp, cacheFile)
    return true
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
