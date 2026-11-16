/** The process side of a handoff: run the spawn command, close the old session. */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { Config } from './config.ts'
import type { HandoffIO } from './handoff.ts'

// INVARIANT: below the 60 s of TOUCH_TIMEOUT_SEC (hooks.ts) and GATE_TIMEOUT_MS (hooks/gate.ts), with room for the rest of the hook.
export const SPAWN_TIMEOUT_MS = 45_000

export const CLOSE_DELAY_SEC = 2

/** The env for a nested `claude`: this session's credentials and config dir, without the child-of-session markers. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    // WORKAROUND: with CLAUDECODE / CLAUDE_CODE_* set a nested `claude` writes no transcript and `--resume` finds nothing.
    if (v === undefined || k === 'CLAUDECODE') continue
    if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN') continue
    out[k] = v
  }
  return out
}

/** `ps -o ppid=,comm=` for one pid, or undefined when it is gone. */
export type ReadPsLine = (pid: number) => string | undefined

const readPsLine: ReadPsLine = pid => {
  try {
    return execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

const MAX_ANCESTORS = 10

// INVARIANT: session titles as `ps -o comm=` prints them (macOS, Claude Code 2.1.303-2.1.304). The daemon `…/.local/bin/claude`
// and `claude bg-pty-host` must never match, nor may the walk pass an unknown `claude` title: closing the daemon ends every background session.
const SESSION_COMM = [/^claude$/, /^claude bg-spare$/, /\/claude\/versions\/\d+\.\d+\.\d+$/]

/** The pid of the session this hook runs in, or undefined when it cannot be told for sure. */
export function claudeAncestor(startPid = process.ppid, ps: ReadPsLine = readPsLine): number | undefined {
  let pid = startPid
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const m = ps(pid)?.match(/^(\d+)\s+(.*)$/)
    if (!m) return undefined
    const [, ppid, comm] = m
    if (comm.includes('claude')) return SESSION_COMM.some(re => re.test(comm)) ? pid : undefined
    pid = Number(ppid)
  }
  return undefined
}

export function realIO(config: Config): HandoffIO {
  return {
    spawn(command, extra) {
      const r = spawnSync('/bin/sh', ['-c', command], {
        env: { ...childEnv(process.env), ...extra },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SPAWN_TIMEOUT_MS,
      })
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`
      return { ok: r.error === undefined && r.status === 0, output }
    },
    closeLater(sessionId) {
      const pid = claudeAncestor()
      const command = config.handoff.closeCommand ?? (pid ? `kill -TERM ${pid}` : undefined)
      if (!command) return
      // WARNING: detached and delayed by CLOSE_DELAY_SEC: killing the session kills this hook, which must answer first.
      const child = spawn('/bin/sh', ['-c', `sleep ${CLOSE_DELAY_SEC}; ${command}`], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CACHE_KEEPER_SESSION_ID: sessionId, CACHE_KEEPER_CLAUDE_PID: pid ? String(pid) : '' },
      })
      child.on('error', () => {})
      child.unref()
    },
  }
}
