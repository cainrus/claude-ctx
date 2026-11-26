/**
 * A hook that fails never breaks your session; it leaves three traces instead: a line in
 * `$CTX_KEEPER_HOME/errors.log` (rotated to errors.log.1 past 256 KB), an `error` event that `report` counts,
 * and `error: <hook> failed` on the status line until a turn is recorded cleanly again. Without the status line,
 * the session's next prompt gets one notice, at most once an hour.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { appendLedger } from './ledger.ts'
import { postNotice } from './notices.ts'
import { loadSession, saveSession } from './state.ts'

const MAX_LOG_BYTES = 256 * 1024
export const ERROR_NOTICE_EVERY_MS = 3600_000

export function errorLogPath(home: string): string {
  return join(home, 'errors.log')
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
}

function whereOf(err: unknown): string | undefined {
  const stack = err instanceof Error ? err.stack : undefined
  const frame = stack?.split('\n').find((l) => /\/(src|bin|hooks)\/[^/]+\.ts:\d+/.test(l))
  return frame?.trim().replace(/^at\s+/, '')
}

const quiet = (fn: () => void) => {
  try {
    fn()
  } catch {
  }
}

export function recordError(home: string, cmd: string, sessionId: string | undefined, err: unknown, now: number): void {
  const message = messageOf(err)
  const where = whereOf(err)
  const path = errorLogPath(home)
  quiet(() => {
    mkdirSync(home, { recursive: true })
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {}
    appendFileSync(path, `${new Date(now).toISOString()} ${cmd} ${sessionId ?? '-'} ${message}${where ? ` (${where})` : ''}\n`)
  })
  quiet(() => appendLedger(home, { t: new Date(now).toISOString(), sessionId: sessionId ?? '-', event: 'error', detail: `${cmd}: ${message}` }))
  if (!sessionId) return
  quiet(() => {
    const state = loadSession(home, sessionId)
    if (!state) return
    state.lastError = { at: now, cmd, message }
    if (now - (state.errorNoticeAt ?? 0) >= ERROR_NOTICE_EVERY_MS) {
      state.errorNoticeAt = now
      postNotice(home, `cache-keeper: the ${cmd} hook failed (${message}). Log: ${path}`, now, [sessionId])
    }
    saveSession(home, state)
  })
}
