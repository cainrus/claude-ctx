/**
 * Reads how long the keyboard and mouse have been idle, before each ping. macOS: `HIDIdleTime`, which keeps
 * counting through a closed lid or a locked screen. Linux: the first that answers of GNOME's Mutter idle monitor,
 * the freedesktop ScreenSaver interface (KDE), `xprintidle` (X11), then logind's idle hint (only with a graphical
 * session). Elsewhere, or when no probe answers, presence is unknown: the `away` row lets the ping through, but the
 * away budget counts it as not at the keyboard. `CTX_KEEPER_IDLE_SEC` overrides the probe (seconds or `unknown`);
 * `CTX_KEEPER_BACKGROUND=0|1` forces a session to count as interactive or background.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './state.ts'

/** `"HIDIdleTime" = 123456789000` (ns) -> whole seconds. */
export function parseIdleSeconds(ioregOutput: string): number | null {
  const m = ioregOutput.match(/"HIDIdleTime"\s*=\s*(\d+)/)
  if (!m) return null
  const ns = Number(m[1])
  if (!Number.isFinite(ns)) return null
  return Math.floor(ns / 1_000_000_000)
}

/** `CTX_KEEPER_IDLE_SEC`: a number is the idle time; `unknown` or anything non-numeric is null. */
export function parseIdleOverride(raw: string): number | null {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

export type Exec = (cmd: string, args: string[]) => string

const PROBE_TIMEOUT_MS = 2000

const defaultExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exec?: Exec
  /** Epoch ms. */
  now?: number
  uid?: number
}

export function readIdleSeconds(opts: ProbeOptions = {}): number | null {
  const env = opts.env ?? process.env
  const override = env.CTX_KEEPER_IDLE_SEC
  if (override !== undefined) return parseIdleOverride(override)
  const exec = opts.exec ?? defaultExec
  const platform = opts.platform ?? process.platform
  if (platform === 'linux') return linuxIdleSeconds(exec, opts.now ?? Date.now(), opts.uid ?? process.getuid?.() ?? 0)
  if (platform !== 'darwin') return null
  try {
    return parseIdleSeconds(exec('ioreg', ['-c', 'IOHIDSystem', '-d', '4']))
  } catch {
    return null
  }
}

/** `(uint64 12345,)` from `gdbus call` -> the number. */
export function parseGdbusUint(out: string): number | null {
  const m = out.match(/^\(\s*(?:uint32|uint64)\s+(\d+)\s*,?\s*\)\s*$/m)
  return m ? Number(m[1]) : null
}

export function parseBareInt(out: string): number | null {
  const s = out.trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

/** `loginctl show-user` lines -> idle seconds. */
export function parseLoginctlUser(out: string, now: number): number | null {
  const props = new Map<string, string>()
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) props.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  // INVARIANT: trusted only with a graphical session: without a desktop to set it, IdleHint can stay "no"
  // forever, read as "at the keyboard", and lift the away budget.
  if (!props.get('Display')) return null
  const hint = props.get('IdleHint')
  if (hint === 'no') return 0
  if (hint !== 'yes') return null
  const sinceUs = Number(props.get('IdleSinceHint'))
  if (!Number.isFinite(sinceUs) || sinceUs <= 0) return null
  return Math.max(0, Math.floor((now - sinceUs / 1000) / 1000))
}

const gdbus = (dest: string, path: string, method: string) => [
  'call', '--session', '--dest', dest, '--object-path', path, '--method', method,
]

interface LinuxProbe {
  name: string
  cmd: string
  args: (uid: number) => string[]
  /** null tries the next probe. */
  parse: (out: string, now: number) => number | null
}

const msToSec = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000))

// WARNING: order matters. The precise probes need the desktop's session bus or X display, which a hook inherits
// from an interactive session but not from a daemon-spawned one; logind needs neither, so it is the last resort.
export const LINUX_PROBES: readonly LinuxProbe[] = [
  {
    name: 'mutter', // GNOME, X11 and Wayland: milliseconds
    cmd: 'gdbus',
    args: () => gdbus('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core', 'org.gnome.Mutter.IdleMonitor.GetIdletime'),
    parse: (out) => msToSec(parseGdbusUint(out)),
  },
  {
    name: 'screensaver', // KDE and others implementing the freedesktop interface: seconds
    cmd: 'gdbus',
    args: () => gdbus('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver.GetSessionIdleTime'),
    parse: (out) => parseGdbusUint(out),
  },
  {
    name: 'xprintidle', // any X11 session: milliseconds
    cmd: 'xprintidle',
    args: () => [],
    parse: (out) => msToSec(parseBareInt(out)),
  },
  {
    name: 'logind', // systemd, no bus or display needed; as coarse as the desktop's idle delay
    cmd: 'loginctl',
    args: (uid) => ['show-user', String(uid), '-p', 'Display', '-p', 'IdleHint', '-p', 'IdleSinceHint'],
    parse: parseLoginctlUser,
  },
]

export function linuxIdleSeconds(exec: Exec, now: number, uid: number): number | null {
  for (const p of LINUX_PROBES) {
    try {
      const v = p.parse(exec(p.cmd, p.args(uid)), now)
      if (v !== null && Number.isFinite(v) && v >= 0) return v
    } catch {}
  }
  return null
}

/** The prompt a background job was started with (`claude --bg`, a dispatcher): its launch, not a person at its input box. */
export function isJobLaunchPrompt(text: string | undefined, env: NodeJS.ProcessEnv = process.env, textLength?: number, maybeCut = false): boolean {
  // WORKAROUND: Claude Code 2.1.332 stamps a background job's launch prompt as typed (origin `composer`), so it read as
  // the person's own; the job keeps that prompt as `intent` in $CLAUDE_JOB_DIR/state.json, and only a prompt equal to it is told apart.
  const dir = env.CLAUDE_JOB_DIR
  if (!dir || typeof text !== 'string' || text === '') return false
  const intent = readJson<{ intent?: unknown }>(join(dir, 'state.json'))?.intent
  // a caller may send only the head of a long prompt, with its full length, or a head of unknown length (`maybeCut`)
  if (typeof intent !== 'string' || !intent.startsWith(text)) return false
  return intent.length === (textLength ?? text.length) || (maybeCut && text.length >= GATE_TEXT_CHARS)
}

/** The mod's gate sends at most this much of a turn's text (hooks/gate.ts HELD_CHARS). */
export const GATE_TEXT_CHARS = 4000

const KIND_TAIL_BYTES = 16_384

/** A session nobody watches at an input box. */
export function isBackgroundSession(env: NodeJS.ProcessEnv = process.env, transcriptPath?: string): boolean {
  const forced = env.CTX_KEEPER_BACKGROUND
  if (forced === '0' || forced === '1') return forced === '1'
  // WARNING: Claude Code starts background sessions with CLAUDE_JOB_DIR and stamps their transcript lines
  // "sessionKind":"bg"; hooks inherit the env var, the transcript is the fallback.
  if (env.CLAUDE_JOB_DIR) return true
  if (!transcriptPath) return false
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, KIND_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8').includes('"sessionKind":"bg"')
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}
