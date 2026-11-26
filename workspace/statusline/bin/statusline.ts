#!/usr/bin/env node
/**
 * What the status line's mod cannot do from inside Claude Code: append to a
 * journal, replace a file whole, run git under a lock. The mod runs one command
 * at a time, its input as JSON on stdin; every command exits 0 and prints
 * nothing, so a failure never reaches the session.
 *
 *   rate       {dir, account, session, at, limits}       one journal step (src/rates.ts)
 *   barometer  {file, at, session, version, limits}       the barometer feed (src/barometer.ts)
 *   git        {workdir, gitDir, cacheFile}               the checkout's counts (src/gitcache.ts)
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { barometerJson, writeBarometer, type BarometerLimit } from '../src/barometer.ts'
import { refreshCounts } from '../src/gitcache.ts'
import { recordRates, windowOf, type RatePair } from '../src/rates.ts'

type Json = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export function runCommand(cmd: string | undefined, input: Json): boolean {
  if (cmd === 'rate') {
    const dir = str(input.dir)
    const account = str(input.account)
    if (dir === undefined || account === undefined || account.includes('/')) return false
    const limits = (Array.isArray(input.limits) ? input.limits : []) as Array<{ kind?: unknown }>
    const pair: RatePair = {
      five: windowOf(limits.find((l) => l?.kind === 'five_hour') as never),
      week: windowOf(limits.find((l) => l?.kind === 'seven_day') as never),
    }
    return recordRates(dir, account, str(input.session) ?? '', Number(input.at) || Math.floor(Date.now() / 1000), pair)
  }
  if (cmd === 'barometer') {
    const file = str(input.file)
    if (file === undefined) return false
    const limits = (Array.isArray(input.limits) ? input.limits : []) as BarometerLimit[]
    writeBarometer(file, barometerJson(Number(input.at) || Math.floor(Date.now() / 1000), str(input.session) ?? null, str(input.version) ?? null, limits))
    return true
  }
  if (cmd === 'git') {
    const workdir = str(input.workdir)
    const gitDir = str(input.gitDir)
    const cacheFile = str(input.cacheFile)
    if (workdir === undefined || gitDir === undefined || cacheFile === undefined) return false
    return refreshCounts(workdir, gitDir, cacheFile)
  }
  return false
}

/** Run as a script, not imported: by the real path, so a link or a space in the plugin's path does not turn every command off. */
function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    const raw = readFileSync(0, 'utf8')
    runCommand(process.argv[2], raw.trim() === '' ? {} : (JSON.parse(raw) as Json))
  } catch {
    // INVARIANT: the status line's helpers never fail a session: any error is exit 0 with no output.
  }
  process.exit(0)
}
