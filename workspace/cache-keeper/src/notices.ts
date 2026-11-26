/**
 * Something keeper did while nobody watched is shown once in each session it concerns, on that session's next
 * real prompt, then never again there. Notices older than a day are dropped.
 */

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readJson, writeJsonAtomic } from './state.ts'

export const NOTICE_TTL_MS = 24 * 3600_000

export interface Notice {
  id: string
  /** Epoch ms. */
  t: number
  text: string
  /** Unset: every session sees it. */
  sessions?: string[]
  seenBy: string[]
}

const dir = (home: string) => join(home, 'notices')

export function postNotice(home: string, text: string, now: number, sessions?: string[]): Notice {
  const seq = process.hrtime.bigint().toString().padStart(20, '0')
  const notice: Notice = { id: `${now}-${seq}-${randomBytes(2).toString('hex')}`, t: now, text, seenBy: [] }
  if (sessions) notice.sessions = sessions
  writeJsonAtomic(join(dir(home), `${notice.id}.json`), notice)
  return notice
}

/** Marks what it returns as seen; deletes expired notices. */
export function takeNotices(home: string, sessionId: string, now: number): string[] {
  let names: string[]
  try {
    names = readdirSync(dir(home)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    const path = join(dir(home), name)
    const n = readJson<Notice>(path)
    if (!n || typeof n.text !== 'string') continue
    if (now - n.t > NOTICE_TTL_MS) {
      rmSync(path, { force: true })
      continue
    }
    if (n.sessions && !n.sessions.includes(sessionId)) continue
    const seenBy = Array.isArray(n.seenBy) ? n.seenBy : []
    if (seenBy.includes(sessionId)) continue
    writeJsonAtomic(path, { ...n, seenBy: [...seenBy, sessionId] })
    out.push(n.text)
  }
  return out
}
