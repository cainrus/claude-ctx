/**
 * Each subagent's row in the agent panel leads its words with what the row does
 * not say itself: the model, the context it has burnt against its window, and
 * how long it has run, `opus · 105k/1M · 12м`, with a mark once it ended (`✓`
 * done, `❌` failed, `⏹` stopped). The engine keeps the name and its columns;
 * the agent's own words follow, cut where the row ends.
 */

/** `claude-opus-5` -> `opus`, `claude-haiku-4-5-20251001` -> `haiku`; an id it cannot read passes through. */
export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku|fable|mythos)/i.exec(model)
  return m === null ? model : m[1]!.toLowerCase()
}

/** 105077 -> `105k`, 1000000 -> `1M`. */
export function humanTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  const m = n / 1_000_000
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`
}

/** Elapsed since `startMs`: `сейчас`, `12м`, `3ч`, `2д`. */
export function shortAge(startMs: number | undefined, now: number): string {
  if (startMs === undefined) return ''
  const ms = now - startMs
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'сейчас'
  if (min < 60) return `${min}м`
  const h = Math.floor(min / 60)
  return h < 48 ? `${h}ч` : `${Math.floor(h / 24)}д`
}

/** A running agent is animated by the panel already; only an end is worth a glyph. */
export function statusMark(taskStatus: string): string {
  if (taskStatus === 'failed') return '❌ '
  if (taskStatus === 'killed') return '⏹ '
  if (taskStatus === 'completed') return '✓ '
  return ''
}

export interface AgentFacts {
  model?: string
  tokenCount?: number
  contextWindowSize?: number
  startTime?: number
  taskStatus?: string
}

/** The decoration within `width` columns: the age goes first, the model last. */
export function agentText(a: AgentFacts, now: number, width: number): string {
  const parts: string[] = []
  if (a.model) parts.push(shortModel(a.model))
  if (typeof a.tokenCount === 'number' && Number.isFinite(a.tokenCount)) {
    parts.push(a.contextWindowSize ? `${humanTokens(a.tokenCount)}/${humanTokens(a.contextWindowSize)}` : humanTokens(a.tokenCount))
  }
  const age = shortAge(a.startTime, now)
  if (age !== '') parts.push(age)
  const mark = statusMark(a.taskStatus ?? '')
  while (parts.length > 1 && `${mark}${parts.join(' · ')}`.length > width) parts.pop()
  const line = `${mark}${parts.join(' · ')}`
  return line.length > width ? line.slice(0, Math.max(0, width)) : line
}

/** The row's words: the decoration, then the agent's own label. */
export function agentLabel(a: AgentFacts, label: string, now: number, columns: number | undefined): string {
  const lead = agentText(a, now, Math.max(8, Math.min(columns ?? 80, 40)))
  if (lead === '') return label
  return label === '' ? lead : `${lead} · ${label}`
}
