import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { DONE_COMMAND, DONE_REPLY, end, isDoneCommand, isWakePrompt, record, touch, TRANSCRIPT_CATCH_UP_MS, wake, WAKE_MESSAGE } from '../src/commands.ts'
import { readLedger } from '../src/ledger.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { rateFor } from '../src/prices.ts'
import { compactedSinceRequest, loadAwayBudget, loadSession, newSession, saveAwayBudget, saveSession } from '../src/state.ts'
import { assistantLine, configFor, FIXTURES, makeCtx, MIN, SID, tempHome, userLine, writeLines, writeTranscript } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const BIG = { read: 90_000, write: 1_000 }
const WARM_ENOUGH = (T.minAgeSec + 60) * 1000

/** A session whose last turn ended at T0 with a large context. */
function setup(env: Record<string, string> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  return { home, config, transcript }
}

// --- record ------------------------------------------------------------------

test('record: cache age starts at the last assistant entry, not at the hook clock', () => {
  const { home } = setup()
  const s = loadSession(home, SID)!
  assert.equal(s.lastTurnEndAt, T0)
  assert.equal(s.ctxTokens, 5 + BIG.read + BIG.write)
  assert.equal(s.model, 'claude-opus-4-5')
})

test('record: prices the next turn at this context for the status line, warm read and cold write', () => {
  const { home, config } = setup()
  const s = loadSession(home, SID)!
  const r = rateFor(s.model, config.prices, s.ctxTokens)
  assert.equal(s.warmTurnUsd, (s.ctxTokens * r.cacheRead) / 1e6)
  assert.equal(s.coldTurnUsd, (s.ctxTokens * r.cacheWrite) / 1e6)
  assert.ok(s.coldTurnUsd! > s.warmTurnUsd!)
})

test('record: an entry older than the last prompt means the transcript lags — use now', () => {
  const home = tempHome()
  const config = configFor(home)
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 + 10 * MIN })
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 11 * MIN))
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, T0 + 11 * MIN)
})

// Seen live: the Stop closing the second wake ran before the wake's assistant
// entry reached the disk, and the previous wake's usage was scored in its place.
test('record: waits for the wake turn to reach the transcript instead of scoring the previous one', () => {
  const home = tempHome()
  const config = configFor(home)
  const pingAt = T0 + 50 * MIN
  saveSession(home, { ...newSession(SID), pendingPing: true, lastPingAt: pingAt })
  const transcript = writeTranscript(home, [{ at: T0, read: 57_225, write: 889 }])
  const ctx = makeCtx(config, pingAt + 3_000)
  ctx.sleepMs = (ms) => {
    ctx.slept += ms
    appendFileSync(transcript, `${assistantLine({ at: pingAt + 1_500, read: 58_114, write: 765 })}\n`)
  }
  record({ session_id: SID, transcript_path: transcript }, ctx)
  const hit = readLedger(home).find((e) => e.event === 'wake-hit')
  assert.ok(hit)
  assert.equal(hit.cacheRead, 58_114)
  assert.equal(hit.cacheWrite, 765)
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, pingAt + 1_500)
})

test('record: a wake turn that never reaches the transcript is left unscored', () => {
  const home = tempHome()
  const config = configFor(home)
  const pingAt = T0 + 50 * MIN
  saveSession(home, { ...newSession(SID), pendingPing: true, lastPingAt: pingAt })
  const transcript = writeTranscript(home, [{ at: T0, read: 57_225, write: 889 }])
  const ctx = makeCtx(config, pingAt + 3_000)
  record({ session_id: SID, transcript_path: transcript }, ctx)
  assert.equal(ctx.slept, TRANSCRIPT_CATCH_UP_MS)
  assert.deepEqual(readLedger(home).filter((e) => String(e.event).startsWith('wake-')), [])
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.lastPingHit, null)
})

test('record: without a transcript it still stamps the turn', () => {
  const home = tempHome()
  record({ session_id: SID }, makeCtx(configFor(home), T0))
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, T0)
  assert.equal(record({}, makeCtx(configFor(home), T0)), 0)
})

test('record: the oracle scores a wake turn as a hit (fixture: 57k read / 911 written)', () => {
  const home = tempHome()
  const config = configFor(home)
  saveSession(home, { ...newSession(SID), pendingPing: true, pingsSoFar: 1 })
  record(
    { session_id: SID, transcript_path: join(FIXTURES, 'wake-hit.jsonl'), stop_hook_active: true },
    makeCtx(config, T0 + 51 * MIN),
  )
  const s = loadSession(home, SID)!
  assert.equal(s.lastPingHit, true)
  assert.equal(s.pendingPing, false)
  const [line] = readLedger(home)
  assert.equal(line.event, 'wake-hit')
  assert.equal(line.cacheRead, 57_129)
  assert.equal(line.cacheWrite, 911)
})

test('record: the oracle scores a full rewrite as a miss, which mutes the session', () => {
  const home = tempHome()
  const config = configFor(home)
  saveSession(home, { ...newSession(SID), pendingPing: true, pingsSoFar: 1 })
  record({ session_id: SID, transcript_path: join(FIXTURES, 'wake-miss.jsonl') }, makeCtx(config, T0))
  assert.equal(loadSession(home, SID)!.lastPingHit, false)
  assert.equal(readLedger(home)[0].event, 'wake-miss')
})

test('record: the hit ratio threshold is inclusive and configurable', () => {
  const home = tempHome()
  const transcript = writeTranscript(home, [{ at: T0, read: 90, write: 10 }])
  for (const [ratio, hit] of [['0.9', true], ['0.91', false]] as const) {
    saveSession(home, { ...newSession(SID), pendingPing: true })
    record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home, { CTX_KEEPER_HIT_RATIO: ratio }), T0))
    assert.equal(loadSession(home, SID)!.lastPingHit, hit, `ratio ${ratio}`)
  }
})

test('record: stop_hook_active without our pending wake is not scored', () => {
  const home = tempHome()
  const config = configFor(home)
  record({ session_id: SID, transcript_path: join(FIXTURES, 'wake-miss.jsonl'), stop_hook_active: true }, makeCtx(config, T0))
  assert.equal(loadSession(home, SID)!.lastPingHit, null)
  assert.deepEqual(readLedger(home), [])
})

// --- wake --------------------------------------------------------------------

test('wake: pings an idle session — exit 2, message on stderr, state and ledger updated', () => {
  const { home, config } = setup()
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, 30)
  assert.equal(wake({ session_id: SID }, ctx), 2)
  assert.deepEqual(ctx.errors, [`${WAKE_MESSAGE}\n`])
  const s = loadSession(home, SID)!
  assert.equal(s.pingsSoFar, 1)
  assert.equal(s.pendingPing, true)
  assert.equal(s.lastPingAt, T0 + WARM_ENOUGH)
  const [line] = readLedger(home)
  assert.equal(line.event, 'ping')
  assert.equal(line.ageSec, T.minAgeSec + 60)
  assert.equal(line.awaySeconds, 30)
})

test('wake: a stale sleeper (a newer turn ended since) exits 0 silently', () => {
  const { home, config } = setup()
  const ctx = makeCtx(config, T0 + (T.minAgeSec - 1) * 1000)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(ctx.errors, [])
  assert.equal(ctx.probes, 0, 'no presence probe for a stale sleeper')
  assert.deepEqual(readLedger(home), [])
})

test('wake: a turn that started after the last Stop makes the sleeper stale', () => {
  const { home, config } = setup()
  touch({ session_id: SID, prompt: 'next task' }, makeCtx(config, T0 + 5 * MIN))
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH)), 0)
  assert.deepEqual(readLedger(home), [])
})

test('wake: no state (session ended) or no session id exits 0', () => {
  const home = tempHome()
  const config = configFor(home)
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0)), 0)
  assert.equal(wake({}, makeCtx(config, T0)), 0)
})

test('wake: disabled by env exits 0 without touching anything', () => {
  const { home } = setup()
  const ctx = makeCtx(configFor(home, { CTX_KEEPER_DISABLED: '1' }), T0 + WARM_ENOUGH)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(readLedger(home), [])
})

test('wake: a refusal is logged with its reason and exits 0', () => {
  const { home, config } = setup()
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, T.awaySec + 1)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(ctx.errors, [])
  const [line] = readLedger(home)
  assert.equal(line.event, 'skip')
  assert.equal(line.reason, 'away')
})

// --- away budget -------------------------------------------------------------

test('wake: a skipIf veto refuses the ping without spending any budget', () => {
  const { home, config, transcript } = setup()
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, 30)
  const seen: unknown[] = []
  ctx.skipIf = (facts) => {
    seen.push(facts)
    return 'skip'
  }
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(ctx.errors, [])
  assert.deepEqual(seen, [{ sessionId: SID, transcriptPath: transcript, lastPromptAt: undefined }])
  const s = loadSession(home, SID)!
  assert.equal(s.pingsSoFar, 0)
  assert.equal(s.pendingPing, false)
  const [line] = readLedger(home)
  assert.equal(line.event, 'skip')
  assert.equal(line.reason, 'skip-if')
})

test('wake: skipIf answering no lets the ping through', () => {
  const { config } = setup()
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, 30)
  ctx.skipIf = () => 'ping'
  assert.equal(wake({ session_id: SID }, ctx), 2)
})

test('wake: skipIf is asked only when a ping or a handoff would go out', () => {
  const { home, config } = setup()
  let asked = 0
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, T.awaySec + 1)
  ctx.skipIf = () => {
    asked++
    return 'skip'
  }
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.equal(asked, 0)
  assert.equal(readLedger(home)[0].reason, 'away')
})

test('away budget: a ping while away spends it, a ping at the keyboard does not', () => {
  const away = setup()
  wake({ session_id: SID }, makeCtx(away.config, T0 + WARM_ENOUGH, T.presenceSec + 1))
  assert.equal(loadAwayBudget(away.home).awayPingsSincePresence, 1)

  const here = setup()
  wake({ session_id: SID }, makeCtx(here.config, T0 + WARM_ENOUGH, T.presenceSec))
  assert.equal(loadAwayBudget(here.home).awayPingsSincePresence, 0)
})

test('away budget: an unknown probe spends it', () => {
  const { home, config } = setup()
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH, null)), 2)
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 1)
})

test('away budget: once spent, every session is refused until presence refills it', () => {
  const { home, config } = setup()
  saveAwayBudget(home, { awayPingsSincePresence: T.maxAwayPings })
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH, T.presenceSec + 1)), 0)
  assert.equal(readLedger(home).at(-1)?.reason, 'away-budget-spent')

  // Presence observed: refilled, and this ping (at the keyboard) is free.
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH, 10)), 2)
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 0)
})

test('away budget: shared by all sessions of the machine', () => {
  const home = tempHome()
  const config = configFor(home)
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  const ids = Array.from({ length: T.maxAwayPings + 2 }, (_, i) => `session-${i}`)
  const codes = ids.map((id) => {
    record({ session_id: id, transcript_path: transcript }, makeCtx(config, T0))
    return wake({ session_id: id }, makeCtx(config, T0 + WARM_ENOUGH, T.presenceSec + 1))
  })
  assert.equal(codes.filter((c) => c === 2).length, T.maxAwayPings)
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, T.maxAwayPings)
})

// --- touch / end -------------------------------------------------------------

test('touch: a real prompt resets the stretch and logs the resume', () => {
  const { home, config } = setup()
  wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH))
  touch({ session_id: SID, prompt: 'back to work' }, makeCtx(config, T0 + WARM_ENOUGH + MIN))
  const s = loadSession(home, SID)!
  assert.equal(s.pingsSoFar, 0)
  assert.equal(s.pendingPing, false)
  assert.equal(s.lastHumanAt, T0 + WARM_ENOUGH + MIN)
  const resume = readLedger(home).at(-1)!
  assert.equal(resume.event, 'resume')
  assert.equal(resume.pings, 1)
})

test('record: the first turn after a pinged resume logs what its FIRST request paid', () => {
  const { home, config, transcript } = setup()
  wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH))
  appendFileSync(transcript, `${assistantLine({ at: T0 + WARM_ENOUGH + 1000, read: 91_000, write: 300 })}\n`)
  record({ session_id: SID, transcript_path: transcript, stop_hook_active: true }, makeCtx(config, T0 + WARM_ENOUGH + 2000))

  const back = T0 + WARM_ENOUGH + 10 * MIN
  touch({ session_id: SID, prompt: 'back to work' }, makeCtx(config, back))
  // The first request rewrote the prefix; the second reads that fresh write and would look like a hit.
  appendFileSync(transcript, `${assistantLine({ at: back + 1000, read: 0, write: 91_000 })}\n`)
  appendFileSync(transcript, `${assistantLine({ at: back + 5000, read: 91_000, write: 200 })}\n`)
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, back + 6000))

  const paid = readLedger(home).filter((e) => e.event === 'resume-paid')
  assert.equal(paid.length, 1)
  assert.equal(paid[0].cacheRead, 0)
  assert.equal(paid[0].cacheWrite, 91_000)
  assert.equal(loadSession(home, SID)!.resumeAt, undefined)

  // Only the first turn after the resume is measured.
  appendFileSync(transcript, `${assistantLine({ at: back + 9 * MIN, read: 91_500, write: 100 })}\n`)
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, back + 9 * MIN + 500))
  assert.equal(readLedger(home).filter((e) => e.event === 'resume-paid').length, 1)
})

test('touch: the wake turn\'s own prompt is ignored', () => {
  const { home, config } = setup()
  wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH))
  touch({ session_id: SID, prompt: `Stop hook feedback:\n${WAKE_MESSAGE}` }, makeCtx(config, T0 + WARM_ENOUGH + 1000))
  const s = loadSession(home, SID)!
  assert.equal(s.pingsSoFar, 1)
  assert.equal(s.pendingPing, true)
  assert.equal(s.lastHumanAt, undefined)
  assert.equal(readLedger(home).length, 1)
  assert.ok(isWakePrompt(WAKE_MESSAGE))
  assert.ok(!isWakePrompt('ok'))
})

test('touch: no resume line for a stretch without pings; creates state for a new session', () => {
  const home = tempHome()
  touch({ session_id: SID, prompt: 'hi' }, makeCtx(configFor(home), T0))
  assert.equal(loadSession(home, SID)!.lastHumanAt, T0)
  assert.deepEqual(readLedger(home), [])
})

test('end: deletes the session state; a sleeper afterwards finds nothing', () => {
  const { home, config } = setup()
  end({ session_id: SID }, makeCtx(config, T0))
  assert.equal(loadSession(home, SID), undefined)
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH)), 0)
})

// --- the whole loop ----------------------------------------------------------

test('loop: pings every ~50 min while hits keep landing, stops at the per-stretch budget', () => {
  const home = tempHome()
  const config = configFor(home)
  let t = T0
  let transcript = writeTranscript(home, [{ at: t, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, t))

  const codes: number[] = []
  for (let i = 0; i < T.maxPings + 1; i++) {
    t += WARM_ENOUGH
    const code = wake({ session_id: SID }, makeCtx(config, t, 60))
    codes.push(code)
    if (code !== 2) break
    // The wake turn lands a few seconds later and its Stop is recorded.
    transcript = writeTranscript(home, [{ at: t + 3000, read: 91_000, write: 200 }])
    record({ session_id: SID, transcript_path: transcript, stop_hook_active: true }, makeCtx(config, t + 3500))
    t += 3000
  }
  assert.deepEqual(codes, [...Array(T.maxPings).fill(2), 0])
  const events = readLedger(home).map((e) => e.event)
  assert.equal(events.filter((e) => e === 'wake-hit').length, T.maxPings)
  assert.equal(readLedger(home).at(-1)?.reason, 'budget-spent')
})

// --- /ctx:done -------------------------------------------------------

test('done: blocks the command, mutes the session and keeps the stretch open', () => {
  const { home, config } = setup()
  wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH))
  const out: string[] = []
  const ctx = { ...makeCtx(config, T0 + WARM_ENOUGH + MIN), stdout: (t: string) => out.push(t) }
  assert.equal(touch({ session_id: SID, prompt: DONE_COMMAND }, ctx), 0)
  assert.deepEqual(JSON.parse(out[0]), { decision: 'block', reason: DONE_REPLY })
  const s = loadSession(home, SID)!
  assert.equal(s.doneAt, T0 + WARM_ENOUGH + MIN)
  assert.equal(s.pingsSoFar, 1, 'the command is not a resume')
  assert.equal(s.lastHumanAt, undefined)
  assert.deepEqual(readLedger(home).map((e) => e.event), ['ping', 'done'])
})

test('done: the next wake is refused with reason done, and no handoff is asked', () => {
  const { home, config } = setup({ CTX_KEEPER_HANDOFF: '1', CTX_KEEPER_HANDOFF_MIN_CTX_TOKENS: '1' })
  touch({ session_id: SID, prompt: '/ctx:done' }, makeCtx(config, T0 + MIN))
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, T.awaySec + 1)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(ctx.errors, [])
  const last = readLedger(home).at(-1)!
  assert.equal(last.event, 'skip')
  assert.equal(last.reason, 'done')
})

test('done: a real prompt lifts it', () => {
  const { home, config } = setup()
  touch({ session_id: SID, prompt: DONE_COMMAND }, makeCtx(config, T0 + MIN))
  touch({ session_id: SID, prompt: 'one more thing' }, makeCtx(config, T0 + 2 * MIN))
  assert.equal(loadSession(home, SID)!.doneAt, undefined)
})

test('done: only the namespaced command matches', () => {
  assert.ok(isDoneCommand('/ctx:done'))
  assert.ok(isDoneCommand('  /ctx:done  '))
  assert.ok(isDoneCommand('/ctx:done for today'))
  assert.ok(!isDoneCommand('/done'))
  assert.ok(!isDoneCommand('/ctx:doneish'))
  assert.ok(!isDoneCommand('please run /ctx:done'))
})

// --- cache bucket, request start, first-turn price ---------------------------------

test('record: the cache bucket is the one the turn wrote; a read-only turn keeps the previous', () => {
  const home = tempHome()
  const config = configFor(home)
  const turn = (at: number, spec: Partial<Parameters<typeof assistantLine>[0]>) => {
    const transcript = writeTranscript(home, [{ at, ...BIG, ...spec }])
    record({ session_id: SID, transcript_path: transcript }, makeCtx(config, at + 500))
    return loadSession(home, SID)!.cacheTtlSec
  }
  assert.equal(turn(T0, { split: { h1: 1_000 } }), 3600)
  assert.equal(turn(T0 + MIN, { write: 0, split: { m5: 0, h1: 0 } }), 3600, 'read-only: kept')
  assert.equal(turn(T0 + 2 * MIN, { write: 800, split: { m5: 800 } }), 300)
  assert.equal(turn(T0 + 3 * MIN, { write: 0, read: 90_000 }), 300, 'no split in the transcript: kept')
})

test('record: no split ever seen leaves the bucket unset, so the line falls back to the config', () => {
  const { home } = setup()
  assert.equal(loadSession(home, SID)!.cacheTtlSec, undefined)
})

test('record: cacheAnchorAt is the start of the request; lastRequestAt and lastTurnEndAt stay the answer time', () => {
  const home = tempHome()
  const config = configFor(home)
  const transcript = writeLines(home, [userLine(T0 - 25_000, 'do it'), assistantLine({ at: T0, ...BIG })])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  const s = loadSession(home, SID)!
  assert.equal(s.cacheAnchorAt, T0 - 25_000)
  assert.equal(s.lastRequestAt, T0, 'Claude Code clock, as before')
  assert.equal(s.lastTurnEndAt, T0)
})

test('record: a tool loop anchors at its last request, the tool result before the final answer', () => {
  const home = tempHome()
  const transcript = writeLines(home, [
    userLine(T0 - 60_000, 'do it'),
    assistantLine({ at: T0 - 50_000, ...BIG }),
    userLine(T0 - 20_000, [{ type: 'tool_result', content: 'ok' }]),
    assistantLine({ at: T0, ...BIG }),
  ])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  assert.equal(loadSession(home, SID)!.cacheAnchorAt, T0 - 20_000)
})

test('record: no request start in the transcript keeps the anchor at the turn end', () => {
  const { home } = setup()
  assert.equal(loadSession(home, SID)!.cacheAnchorAt, T0)
})

test('record: a prompt queued behind the answer is already in the transcript: the anchor is the latest start before the answer', () => {
  const home = tempHome()
  const transcript = writeLines(home, [userLine(T0 - 25_000, 'do it'), assistantLine({ at: T0, ...BIG }), userLine(T0 + 5_000, 'next')])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  assert.equal(loadSession(home, SID)!.cacheAnchorAt, T0 - 25_000)
})

test('record: a start from before this turn began is not trusted', () => {
  const home = tempHome()
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 - 5_000 })
  const transcript = writeLines(home, [userLine(T0 - 30 * MIN, 'an earlier prompt'), assistantLine({ at: T0, ...BIG })])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  assert.equal(loadSession(home, SID)!.cacheAnchorAt, T0)
})

test('record: the prompt entry stamped just before the prompt hook ran still anchors the turn', () => {
  const home = tempHome()
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 - 24_100 })
  const transcript = writeLines(home, [userLine(T0 - 25_000, 'do it'), assistantLine({ at: T0, ...BIG })])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  assert.equal(loadSession(home, SID)!.cacheAnchorAt, T0 - 25_000)
})

test('record: a transcript that never catches up leaves the anchor at now, not at an earlier turn\'s start', () => {
  const home = tempHome()
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 - 5_000 })
  const transcript = writeLines(home, [userLine(T0 - 30 * MIN, 'an earlier prompt'), assistantLine({ at: T0 - 29 * MIN, ...BIG })])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  const s = loadSession(home, SID)!
  assert.equal(s.lastTurnEndAt, T0 + 500)
  assert.equal(s.cacheAnchorAt, T0 + 500)
})

// A tool-loop turn compacted before its final answer: the compaction lands after the tool result, before the answer.
test('record: a compaction in the middle of a turn does not count as "since the request": lastRequestAt is as before the status change', () => {
  const home = tempHome()
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 - 60_000, compactedAt: T0 - 10_000 })
  const transcript = writeLines(home, [
    userLine(T0 - 60_000, 'do it'),
    assistantLine({ at: T0 - 50_000, ...BIG }),
    userLine(T0 - 20_000, [{ type: 'tool_result', content: 'ok' }]),
    userLine(T0 - 9_000, 'This session is being continued', { isCompactSummary: true }),
    assistantLine({ at: T0, ...BIG }),
  ])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  const s = loadSession(home, SID)!
  assert.equal(s.lastRequestAt, T0, 'the answer time, as main does')
  assert.equal(compactedSinceRequest(s), false, 'the post-compaction request wrote a new cache')
  assert.equal(s.cacheAnchorAt, T0 - 20_000, 'only the status line anchors at the start')
})

test('record: the bucket is the last one any request of this turn wrote, even when the final request is read-only', () => {
  const home = tempHome()
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 - 60_000, cacheTtlSec: 3600 })
  const transcript = writeLines(home, [
    userLine(T0 - 60_000, 'do it'),
    assistantLine({ at: T0 - 50_000, read: 80_000, write: 800, split: { m5: 800 } }),
    userLine(T0 - 20_000, [{ type: 'tool_result', content: 'ok' }]),
    assistantLine({ at: T0, read: 90_000, write: 0 }),
  ])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  assert.equal(loadSession(home, SID)!.cacheTtlSec, 300)
})

test('record: a turn that wrote no bucket keeps the previous one, not an earlier turn\'s', () => {
  const home = tempHome()
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 - 5_000, cacheTtlSec: 3600 })
  const transcript = writeLines(home, [
    userLine(T0 - 30 * MIN, 'old'),
    assistantLine({ at: T0 - 29 * MIN, read: 80_000, write: 800, split: { m5: 800 } }),
    userLine(T0 - 5_000, 'new'),
    assistantLine({ at: T0, read: 90_000, write: 0 }),
  ])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  assert.equal(loadSession(home, SID)!.cacheTtlSec, 3600)
})

test('record: a wake-hit entry says when the ping was sent', () => {
  const home = tempHome()
  const pingAt = T0 + 50 * MIN
  saveSession(home, { ...newSession(SID), pendingPing: true, lastPingAt: pingAt })
  const transcript = writeLines(home, [userLine(pingAt + 500, 'wake'), assistantLine({ at: pingAt + 4_000, ...BIG })])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), pingAt + 4_500))
  const hit = readLedger(home).find((e) => e.event === 'wake-hit')!
  assert.equal(hit.sentAt, new Date(pingAt).toISOString())
  assert.equal(hit.t, new Date(pingAt + 4_500).toISOString())
})

test("record: a new session's first turn is priced from the first request's prompt, in a 1-hour cache, at the current model", () => {
  const home = tempHome()
  const config = configFor(home)
  const first = writeLines(home, [userLine(T0 - 9_000, 'hi'), assistantLine({ at: T0 - 5_000, read: 0, write: 30_000, input: 0 }), assistantLine({ at: T0, ...BIG })])
  record({ session_id: SID, transcript_path: first }, makeCtx(config, T0 + 500))
  const s = loadSession(home, SID)!
  assert.equal(s.coldStartTokens, 30_000)
  const r = rateFor(s.model, config.prices, 30_000)
  assert.equal(s.coldStartUsd, (30_000 * r.cacheWrite) / 1e6)
  assert.ok(s.coldStartUsd! < s.coldTurnUsd!)
  // The session moves to another model: the tokens stay, the price follows the model.
  const grown = writeLines(home, [assistantLine({ at: T0 + MIN, read: 400_000, write: 1_000, model: 'claude-haiku-4-5' })], 'grown.jsonl')
  record({ session_id: SID, transcript_path: grown }, makeCtx(config, T0 + MIN + 500))
  const after = loadSession(home, SID)!
  assert.equal(after.coldStartTokens, 30_000, 'read once')
  const h = rateFor('claude-haiku-4-5', config.prices, 30_000)
  assert.equal(after.coldStartUsd, (30_000 * h.cacheWrite) / 1e6)
  assert.notEqual(after.coldStartUsd, s.coldStartUsd)
})

test('record: a first request out of the scan cap is remembered as not found, not searched again each Stop', () => {
  const home = tempHome()
  const pad = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1024 * 1024) })
  const transcript = writeLines(home, [...Array.from({ length: 17 }, () => pad), assistantLine({ at: T0, ...BIG })])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home), T0 + 500))
  const s = loadSession(home, SID)!
  assert.equal(s.coldStartTokens, 0)
  assert.equal(s.coldStartUsd, undefined)
})
