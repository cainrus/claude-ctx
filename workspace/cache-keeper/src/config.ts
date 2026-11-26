/**
 * Settings come from the defaults, then `$CTX_KEEPER_HOME/config.json`, then env, the later winning.
 * An invalid value (a typo, a negative number) is ignored and the earlier source stays in force.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { THRESHOLDS, type Thresholds } from './policy.ts'
import { mergePrices, type PriceTable } from './prices.ts'

export { DEFAULT_PRICES, type PriceTable } from './prices.ts'

export interface Config {
  home: string
  enabled: boolean
  thresholds: Thresholds
  /** `maxPings` follows the ledger unless env or config.json set it. */
  maxPingsAuto: boolean
  /** A wake turn is a cache hit when read / (read + write) >= this. */
  hitRatio: number
  /** Cache TTL the savings estimate assumes (1h on a subscription). */
  cacheTtlSec: number
  delaySec: number
  prices: PriceTable
  /** Let the plugin's mod send pings as `$.model.fork` instead of a wake turn. */
  forkPings: boolean
  /** Shell command asked before each ping; exit 0 skips it, exit 3 hands off. */
  skipIf?: string
  handoff: HandoffConfig
}

/** Off unless switched on: it costs one extra turn per idle stretch. */
export interface HandoffConfig {
  enabled: boolean
  /** Below this the brief would not save enough to pay for itself. */
  minCtxTokens: number
  /** Starts a new session from the brief (menu choice 2); unset, choice 2 only writes the file. */
  spawnCommand?: string
  closeAfterSpawn: boolean
  /** Closes the old session; unset, SIGTERM to the session's `claude` process. */
  closeCommand?: string
}

export const DEFAULT_DELAY_SEC = 3000

/** One documented setting; the config docs are rendered from SETTINGS. */
export interface SettingDoc {
  /** The config.json key (`handoff.x` for the handoff block), or undefined for an env-only setting. */
  key?: string
  /** The env variable that overrides it; `=1` marks a variable whose meaning is inverted. */
  env?: string
  /** Shown as the default when the loaded config has no value to show (env-only, or no default). */
  defaultText?: string
  meaning: string
}

/** Every setting a user can change, in the order the docs list them. */
export const SETTINGS: readonly SettingDoc[] = Object.freeze([
  { env: 'CTX_KEEPER_DELAY_SEC', defaultText: `\`${DEFAULT_DELAY_SEC}\``, meaning: 'how long the waiter sleeps after each turn; keep it between `minAgeSec` and `maxAgeSec` (env only: the shell reads it)' },
  { env: 'CTX_KEEPER_HOME', defaultText: '`~/.claude-ctx/keeper`', meaning: 'state, ledger and `config.json`' },
  { key: 'enabled', env: 'CTX_KEEPER_DISABLED=1', meaning: 'master switch' },
  { key: 'awaySec', env: 'CTX_KEEPER_AWAY_SEC', meaning: 'idle longer than this = gone' },
  { key: 'presenceSec', env: 'CTX_KEEPER_PRESENCE_SEC', meaning: 'idle up to this = at the keyboard' },
  { key: 'maxAwayPings', env: 'CTX_KEEPER_MAX_AWAY_PINGS', meaning: 'machine-wide pings per absence' },
  { key: 'minCtxTokens', env: 'CTX_KEEPER_MIN_CTX_TOKENS', meaning: 'smallest context worth holding' },
  { key: 'minAgeSec', env: 'CTX_KEEPER_MIN_AGE_SEC', meaning: 'earliest ping' },
  { key: 'maxAgeSec', env: 'CTX_KEEPER_MAX_AGE_SEC', meaning: 'latest ping' },
  { key: 'maxPings', env: 'CTX_KEEPER_MAX_PINGS', meaning: 'pings per idle stretch; unset, it is [tuned](policy.md#the-cap-tunes-itself) from this start, set, the tuning is off' },
  { key: 'hitRatio', env: 'CTX_KEEPER_HIT_RATIO', meaning: 'wake turn counts as a hit at `read / (read + write) ≥` this; a value above 1 is ignored' },
  { key: 'prices', defaultText: 'per model, `src/prices.ts`', meaning: 'USD per million tokens, for `report` and the handoff menu: `{"claude-opus-5-5": {"input": 4, "cacheRead": 0.2, "cacheWrite": 8, "output": 20}}` per model id prefix, or a number for a family (`"opus": 5`: input, with 0.1× read, 2× write, 5× output). No Anthropic API serves prices, so the table is kept by hand; `report` names any model it has no row for' },
  { key: 'skipIf', env: 'CTX_KEEPER_SKIP_IF', meaning: 'shell command asked before each ping or due handoff; exit 0 skips, exit 3 hands off (see [How it decides](policy.md))' },
  { env: 'CTX_KEEPER_IDLE_SEC', meaning: 'override the presence probe (a number of seconds, or `unknown`)' },
  { env: 'CTX_KEEPER_BACKGROUND', meaning: '`0`/`1`: treat the session as interactive / background regardless of `CLAUDE_JOB_DIR` and the transcript' },
  { key: 'statusLine', meaning: 'show the cache line under the prompt (see [Status line](status-line.md)); only `false` turns it off' },
  { key: 'band', meaning: 'draw that line above the prompt with buttons instead, where the mod loads (see [The band](status-line.md#the-band-the-same-line-clickable)); `false` keeps it plain text' },
  { key: 'forkPings', env: 'CTX_KEEPER_FORK', meaning: 'ping with a fork instead of a wake turn where the plugin\'s mod loads (see [Fork pings](fork-pings.md))' },
  { key: 'cacheTtlSec', meaning: 'the cache TTL `/ctx:status`, `/ctx:ping`, the report and the ping timing assume; the status line uses the bucket the last turn really wrote and falls back to this; change it only if yours is not one hour' },
  { key: 'handoff.enabled', env: 'CTX_KEEPER_HANDOFF', meaning: 'write a brief before the cache dies and ask before a prompt hits it cold (see [Handoff](handoff.md))' },
  { key: 'handoff.minCtxTokens', env: 'CTX_KEEPER_HANDOFF_MIN_CTX_TOKENS', meaning: 'below this a brief saves too little' },
  { key: 'handoff.spawnCommand', env: 'CTX_KEEPER_HANDOFF_SPAWN', meaning: 'shell command starting a new session; gets `CTX_KEEPER_BRIEF`, `CTX_KEEPER_SESSION_ID`, `CTX_KEEPER_TRANSCRIPT_PATH`, `CTX_KEEPER_CWD`; 45 s at most' },
  { key: 'handoff.closeAfterSpawn', env: 'CTX_KEEPER_HANDOFF_CLOSE', meaning: 'close the old session after a successful spawn' },
  { key: 'handoff.closeCommand', defaultText: 'SIGTERM to the session\'s `claude`', meaning: 'how to close it; gets `CTX_KEEPER_SESSION_ID`, `CTX_KEEPER_CLAUDE_PID`' },
] satisfies SettingDoc[])

export const THRESHOLD_ENV: Readonly<Record<keyof Thresholds, string>> = Object.freeze({
  awaySec: 'CTX_KEEPER_AWAY_SEC',
  presenceSec: 'CTX_KEEPER_PRESENCE_SEC',
  maxAwayPings: 'CTX_KEEPER_MAX_AWAY_PINGS',
  minCtxTokens: 'CTX_KEEPER_MIN_CTX_TOKENS',
  minAgeSec: 'CTX_KEEPER_MIN_AGE_SEC',
  maxAgeSec: 'CTX_KEEPER_MAX_AGE_SEC',
  maxPings: 'CTX_KEEPER_MAX_PINGS',
})

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.CTX_KEEPER_HOME
  return h && h.trim() !== '' ? h : join(env.HOME ?? homedir(), '.claude-ctx/keeper')
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') return num(Number(v))
  return undefined
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
  }
  return undefined
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function readConfigFile(home: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolveHome(env)
  const file = readConfigFile(home)

  const thresholds: Thresholds = { ...THRESHOLDS }
  let maxPingsAuto = true
  for (const key of Object.keys(THRESHOLDS) as Array<keyof Thresholds>) {
    const v = num(env[THRESHOLD_ENV[key]]) ?? num(file[key])
    if (v === undefined) continue
    thresholds[key] = v
    if (key === 'maxPings') maxPingsAuto = false
  }

  const hitRatio = num(env.CTX_KEEPER_HIT_RATIO) ?? num(file.hitRatio)
  const disabled = bool(env.CTX_KEEPER_DISABLED)
  const prices: PriceTable = mergePrices(file.prices)

  return {
    home,
    enabled: disabled !== undefined ? !disabled : (bool(file.enabled) ?? true),
    thresholds,
    maxPingsAuto,
    hitRatio: hitRatio !== undefined && hitRatio <= 1 ? hitRatio : 0.9,
    cacheTtlSec: num(file.cacheTtlSec) ?? 3600,
    delaySec: num(env.CTX_KEEPER_DELAY_SEC) ?? DEFAULT_DELAY_SEC,
    prices,
    forkPings: bool(env.CTX_KEEPER_FORK) ?? bool(file.forkPings) ?? true,
    skipIf: str(env.CTX_KEEPER_SKIP_IF) ?? str(file.skipIf),
    handoff: loadHandoff(env, file.handoff),
  }
}

function loadHandoff(env: NodeJS.ProcessEnv, raw: unknown): HandoffConfig {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    enabled: bool(env.CTX_KEEPER_HANDOFF) ?? bool(f.enabled) ?? false,
    minCtxTokens: num(env.CTX_KEEPER_HANDOFF_MIN_CTX_TOKENS) ?? num(f.minCtxTokens) ?? 120_000,
    spawnCommand: str(env.CTX_KEEPER_HANDOFF_SPAWN) ?? str(f.spawnCommand),
    closeAfterSpawn: bool(env.CTX_KEEPER_HANDOFF_CLOSE) ?? bool(f.closeAfterSpawn) ?? true,
    closeCommand: str(f.closeCommand),
  }
}
