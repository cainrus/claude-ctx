/**
 * Where the mod loads, the status line moves above the prompt as a row of
 * buttons, `◉ 14:05→~16:35 ↻3 (17+5+15)¢ ✓ ?`, and the status line keeps
 * errors only:
 *
 * - `◉ 14:05→~16:35` and the money after it: as on the status line above;
 *   `final` in place of the button when no ping is coming. The time turns yellow in
 *   the last 10 minutes (half the TTL on a 5-minute cache); the cold line is green:
 *   switching model costs nothing extra now. The status line has no colour.
 * - `↻3`: press to ping now, as `/ctx:ping` does (a fork, no turn);
 *   3 pings are left. Dim while a turn runs.
 * - `✓`: press to stop keeping this session, as `/ctx:done` does;
 *   `✓ done` once it is.
 * - `?`: press to pin the legend; hovering the row shows it too.
 *
 * Without the mod there is no row and no line: the commands are the interface.
 * `"band": false` in config.json keeps the plain-text line instead.
 */

import type { EngineInterface as $ } from 'claude-code'
// WARNING: status.ts imports this module too. Use its functions at call time only: a const of it read while
// this module loads is not initialised yet.
// @ts-ignore TS5097
import { costText, format, type Line, timeText } from './status.ts'
// @ts-ignore TS5097
import { cliArgv, manualPing } from './keepalive.ts'

export interface BandView {
  line: Line
  /** getTimezoneOffset() at the time shown. */
  offsetMin: number
  /** Muted by `/ctx:done`: ✓ shows as done, not as a button. */
  muted: boolean
}

export const LEGEND = [
  '◉ 14:05→~16:35  warm till 14:05 for sure, till about 16:35 if every ping left goes out; `final`: no ping is coming',
  '(a+b+c)¢  a: this session\'s pings so far · b: the next turn read from this cache · c: the pings left; one unit for the whole sum, $(…) once a part reaches a dollar',
  '○ cold · ↺N=X ⇄≥Y  the next turn writes the whole context (N tokens) anew, at X; a new session would pay at least Y for its first turn',
  'yellow time: the cache ends soon (10 minutes, or half the bucket when that is shorter) · green cold: switching model is free now',
  '↻N ping now (N left) · ✓ stop keeping this session · ? pin this legend',
].join('\n')

/** Whether the band replaces the status line. */
export function bandOn(config: Record<string, unknown>): boolean {
  return config.band !== false
}

/** One piece of the row: plain text, or a button by its key. */
export type Part = { text: string; dim?: boolean; color?: 'warning' | 'success' } | { key: 'ping' | 'done' | 'help'; label: string }

/** The row, pure so the tests can drive it. `working`: a turn runs, so no ping button. */
export function partsOf(v: BandView, working: boolean): Part[] {
  const help: Part = { key: 'help', label: '?' }
  if (v.line.kind !== 'cached') return [{ text: format(v.line, v.offsetMin), ...(v.line.kind === 'expired' ? { color: 'success' as const } : {}) }, help]
  const time: { text: string; color?: 'warning' } = { text: timeText(v.line, v.offsetMin) }
  if (v.line.warn) time.color = 'warning'
  const parts: Part[] = [time]
  if (v.line.extends) parts.push(working ? { text: `↻${v.line.left}`, dim: true } : { key: 'ping', label: `↻${v.line.left}` })
  else parts.push({ text: 'final', dim: true })
  const cost = costText(v.line)
  if (cost !== undefined) parts.push({ text: cost, dim: true })
  parts.push(v.muted ? { text: '✓ done', dim: true } : { key: 'done', label: '✓' })
  parts.push(help)
  return parts
}

// One copy per load: status.ts hands a new view at every refresh.
let view: BandView | undefined
let legendPinned = false
let busy = false

/** Called by status.ts at every refresh; undefined empties the band. */
export function setBand($: $, next: BandView | undefined): void {
  const same = JSON.stringify(next) === JSON.stringify(view)
  view = next
  if (same) return
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // Nothing to redraw from here: the next render reads the new view anyway.
  }
}

const CLI_TIMEOUT_MS = 20_000

/** `/ctx:done` as the prompt hook answers it: the same CLI, the same record. */
async function markDone($: $): Promise<string> {
  try {
    const { exitCode, stdout } = await $.process.run(
      cliArgv($, 'touch'),
      { stdin: JSON.stringify({ session_id: await $.session.id(), prompt: '/ctx:done' }), timeoutMs: CLI_TIMEOUT_MS },
    )
    const out = exitCode === 0 ? JSON.parse(stdout.trim().split('\n').pop() ?? '') : undefined
    if (out?.decision === 'block' && typeof out.reason === 'string') return out.reason
  } catch {
    // Fall through: say it did not take.
  }
  return 'cache-keeper: could not mark this session done; /ctx:done does the same.'
}

async function press($: $, key: 'ping' | 'done', refresh: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true
  try {
    // undefined only when the CLI could not be read: a band press never leaves a ping for a turn to close.
    const text = key === 'ping' ? ((await manualPing($, true)) ?? 'cache-keeper: keeper did not answer; whether a ping went out is unknown.') : await markDone($)
    $.ui.toast(text)
  } catch {
    $.ui.toast('cache-keeper: that did not go through.')
  } finally {
    busy = false
    await refresh().catch(() => {})
  }
}

/** gate.ts's `ui.render` hook on `AbovePrompt`. */
export async function renderBand<E extends { props: { hasSurvey: boolean; isWorking: boolean } }, R>(
  $: $,
  e: E,
  next: (e: E) => R | Promise<R>,
  refresh: () => Promise<void>,
): Promise<R> {
  const v = view
  if (v === undefined || e.props.hasSurvey) return next(e)
  try {
    const { Box, Button, Text } = $.ui.resolve(e as never) as ReturnType<$['ui']['resolve']>
    const row = partsOf(v, e.props.isWorking).flatMap((p, i) => {
      const gap = i === 0 ? [] : [h(Text, null, ' ')]
      if ('text' in p) return [...gap, h(Text, { dimColor: p.dim === true, ...(p.color ? { color: p.color } : {}) }, p.text)]
      const key = p.key
      const onPress = key === 'help'
        ? () => {
            legendPinned = !legendPinned
            $.ui.invalidate('ui.render')
          }
        : () => void press($, key, refresh)
      return [...gap, h(Button, { key, onPress }, p.label)]
    })
    const legend = legendPinned
      ? h(Text, { dimColor: true }, LEGEND)
      : h(Box, { display: 'none', hover: { display: 'flex' } }, h(Text, { dimColor: true }, LEGEND))
    return h(Box, { key: 'cache-keeper', flexDirection: 'column' }, h(Box, null, ...row), legend) as R
  } catch {
    // INVARIANT: a failure draws what the engine would: the band must never break a session.
    return next(e)
  }
}
