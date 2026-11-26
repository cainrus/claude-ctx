/**
 * The status line under the prompt, from the engine's own figures: the session
 * (`cc:<id8>`, a link where `CTX_STATUSLINE_SESSION_URL` is set), the account,
 * the session's state and plan where a record of them exists, the branch with
 * `±changed↑unpushed`, the model, the folder being worked on, and the spend:
 * the session's total, `Δ` this turn's input and output sides, `≡` the context
 * against the model's real window. The branch comes first after the account so
 * a narrow pane cuts the money, not the place. `CTX_STATUSLINE_DISABLED=1`
 * hands the line back to the engine.
 */

// WORKAROUND: Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and
// reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
// @ts-ignore TS5097
import { moneyText } from '../../cache-keeper/hooks/status.ts'

export const RESET = '\x1b[0m'
export const DIM = '\x1b[2m'
export const GREEN = '\x1b[32m'
export const YELLOW = '\x1b[33m'
export const RED = '\x1b[31m'

/** Every fact the line is drawn from; each one absent draws no segment of its own. */
export interface Facts {
  sessionId?: string
  /** `CTX_STATUSLINE_SESSION_URL` with `{id}` / `{id8}` filled in. */
  sessionHref?: string
  account?: { label: string; foreign: boolean }
  /** The session record's `display_state` (or the coarse `status` of an older record). */
  state?: SessionState
  plan?: PlanFacts
  branch?: string
  /** Changed files, untracked among them. */
  dirty?: number
  /** Commits ahead of the upstream; absent without one. */
  ahead?: number
  model?: string
  dir?: string
  spend?: SpendFacts
}

export type SessionState = 'broken' | 'unknown' | 'delivered' | 'done_stale' | 'done' | 'ready' | 'ended' | 'working'

export interface PlanFacts {
  total: number
  open: number
  /** `declined`: the session said it is a conversation; `nagged`: asked about a plan, no answer yet. */
  asked?: 'declined' | 'nagged'
  /** Seconds since the plan last changed; absent when unknown. */
  ageSec?: number
}

export interface SpendFacts {
  /** The session so far, USD (the engine's `cost.usd`). */
  totalUsd?: number
  /** This turn's input side (fresh input, cache read, cache write) and output side, USD. */
  turn?: { inUsd: number; outUsd: number }
  /** Tokens the last request was answered over, and the window they fill. */
  context?: { tokens: number; window: number }
}

/** A session past this many dollars shows its total in red: about the 75th percentile of a working session. */
export const TOTAL_ALARM_USD = 50
/** The context goes yellow at this share of the window, red past the second. */
export const CTX_WARN = 0.3
export const CTX_CRIT = 0.6
/** A plan that changed this recently shows 📝. */
export const PLAN_FRESH_SEC = 60

const GLYPHS: Readonly<Record<SessionState, string>> = Object.freeze({
  broken: '❌',
  unknown: '❓',
  delivered: '🚀',
  done_stale: `${DIM}✅${RESET}`,
  done: '✅',
  ready: '🔔',
  ended: '⏹',
  working: '⏳',
})

/** `ESC ] 8 ;; href ESC \ text ESC ] 8 ;; ESC \`: a link the terminal opens on ⌘-click. */
export function osc8(href: string, text: string): string {
  return `\x1b]8;;${href}\x1b\\${text}\x1b]8;;\x1b\\`
}

/** `$.34`, `$7.05`: the total, two decimals, no leading zero. */
export function totalText(usd: number): string {
  return `$${usd.toFixed(2).replace(/^0(?=\.)/, '')}`
}

export function spendText(s: SpendFacts): string | undefined {
  let out = ''
  if (s.totalUsd !== undefined) out += `${s.totalUsd > TOTAL_ALARM_USD ? RED : DIM}${totalText(s.totalUsd)}${RESET}`
  if (s.turn !== undefined) out += `${DIM}Δ${moneyText([s.turn.inUsd, s.turn.outUsd])}${RESET}`
  if (s.context !== undefined && s.context.window > 0) {
    const share = s.context.tokens / s.context.window
    const colour = share > CTX_CRIT ? RED : share >= CTX_WARN ? YELLOW : GREEN
    out += `${DIM}${out === '' ? '' : ' '}≡${RESET}${colour}${Math.round(s.context.tokens / 1000)}k${RESET}`
  }
  return out === '' ? undefined : out
}

export function planText(p: PlanFacts): string | undefined {
  if (!Number.isInteger(p.total) || !Number.isInteger(p.open) || p.total < 0 || p.open < 0) return undefined
  if (p.total > 0) {
    const num = `${p.total - p.open}/${p.total}`
    if (p.ageSec !== undefined && p.ageSec >= 0 && p.ageSec < PLAN_FRESH_SEC) return `📝 ${YELLOW}${num}${RESET}`
    if (p.open === 0) return `🏁 ${GREEN}${num}${RESET}`
    return `📋 ${num}`
  }
  if (p.asked === 'declined') return `${DIM}💬${RESET}`
  if (p.asked === 'nagged') return `📋${YELLOW}?${RESET}`
  return undefined
}

/** `main±2↑1`: the branch with its uncommitted and unpushed marks. */
export function branchText(f: Pick<Facts, 'branch' | 'dirty' | 'ahead'>): string | undefined {
  if (f.branch === undefined || f.branch === '') return undefined
  return `${f.branch}${(f.dirty ?? 0) > 0 ? `±${f.dirty}` : ''}${(f.ahead ?? 0) > 0 ? `↑${f.ahead}` : ''}`
}

/** The whole line: `cc:<id8> account glyph plan · branch · model · dir · spend`. */
export function lineText(f: Facts): string {
  const segments: string[] = []
  let plan = f.plan === undefined ? undefined : planText(f.plan)
  if (plan !== undefined && f.sessionHref !== undefined) plan = osc8(`${f.sessionHref}#plan`, plan)
  if (plan !== undefined) segments.push(plan)
  let branch = branchText(f)
  let dir = f.dir
  // A ticket worktree's folder repeats its branch (LEONWEB-10481-x in leonweb-10481-x): the folder keeps the marks.
  if (branch !== undefined && dir !== undefined && f.branch!.toLowerCase() === dir.toLowerCase()) {
    dir = `${dir}${branch.slice(f.branch!.length)}`
    branch = undefined
  }
  if (branch !== undefined) segments.push(branch)
  if (f.model) segments.push(f.model)
  if (dir) segments.push(dir)
  const spend = f.spend === undefined ? undefined : spendText(f.spend)
  if (spend !== undefined) segments.push(spend)

  const head: string[] = []
  if (f.sessionId !== undefined && /^[0-9a-f]{8}/.test(f.sessionId)) {
    const token = `${DIM}cc:${f.sessionId.slice(0, 8)}${RESET}`
    head.push(f.sessionHref === undefined ? token : osc8(f.sessionHref, token))
  }
  if (f.account !== undefined && f.account.label !== '') head.push(`${f.account.foreign ? YELLOW : DIM}${f.account.label}${RESET}`)
  if (f.state !== undefined) head.push(GLYPHS[f.state])
  const joined = segments.join(' · ')
  return [...head, ...(joined === '' ? [] : [joined])].join(' ')
}

/** `claude-opus-5-5` -> `Opus 5.5`, `claude-haiku-4-5-20251001` -> `Haiku 4.5`; an id it cannot read passes through. */
export function modelName(id: string): string {
  const m = /^(?:[a-z0-9.-]*\.)?claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[[^\]]+\])?$/i.exec(id.trim())
  if (m === null) return id
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}${m[4] ?? ''}`
}

/** The label of a config dir: `CTX_STATUSLINE_ACCOUNTS[basename]`, else the basename after `.claude-`; foreign when the table names it otherwise. */
export function accountOf(configDir: string | undefined, table: Record<string, string>): { label: string; foreign: boolean } | undefined {
  if (configDir === undefined || configDir === '') return undefined
  const base = configDir.replace(/\/+$/, '').split('/').pop() ?? ''
  const plain = base.startsWith('.claude-') ? base.slice('.claude-'.length) : base === '.claude' ? '' : base
  const named = table[base]
  if (named === undefined) return plain === '' ? undefined : { label: plain, foreign: false }
  return { label: named, foreign: named !== plain }
}

/** The session record's fields as the line reads them; a field it cannot read draws nothing. */
export function stateOf(meta: Record<string, unknown> | undefined): SessionState | undefined {
  if (meta === undefined) return undefined
  const d = meta.display_state
  if (typeof d === 'string' && d in GLYPHS) return d as SessionState
  // A record from before display_state: deliberately coarse, the session's next hook stamps the real state.
  if (meta.status === 'done') return 'done'
  if (meta.status === 'ended') return 'ended'
  if (meta.status === 'inprogress') return typeof meta.ended_at === 'string' && meta.ended_at !== '' ? 'ended' : 'working'
  return 'unknown'
}

export function planOf(meta: Record<string, unknown> | undefined, now: number): PlanFacts | undefined {
  if (meta === undefined) return undefined
  const total = meta.plan_total ?? 0
  const open = meta.plan_open ?? 0
  if (typeof total !== 'number' || typeof open !== 'number') return undefined
  const asked = typeof meta.plan_declined_at === 'string' && meta.plan_declined_at !== ''
    ? 'declined'
    : typeof meta.plan_nagged_at === 'string' && meta.plan_nagged_at !== '' ? 'nagged' : undefined
  const changed = typeof meta.plan_changed_at === 'string' ? Date.parse(meta.plan_changed_at) : NaN
  return {
    total,
    open,
    ...(asked !== undefined ? { asked } : {}),
    ...(Number.isFinite(changed) ? { ageSec: Math.floor((now - changed) / 1000) } : {}),
  }
}
