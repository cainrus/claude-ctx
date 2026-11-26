/**
 * The mod's `/ctx:ping` path end to end: hooks/gate.ts's turn.step
 * hands the turn to hooks/keepalive.ts `manualPing`, which runs the real CLI
 * (`ping-now`, then `forked`) against a temporary keeper home. Only the
 * engine is faked: `$.model.fork` answers what each test says.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { record } from '../src/commands.ts'
import { readLedger } from '../src/ledger.ts'
import { loadSession, personPath, readJson, type PersonFacts } from '../src/state.ts'
import { personWritesSettled, register } from '../hooks/gate.ts'
import { manualPing } from '../hooks/keepalive.ts'
import { refresh } from '../hooks/status.ts'
import { configFor, makeCtx, MIN, PLUGIN_ROOT, SID, tempHome, writeTranscript } from './helpers.ts'

const TAG = '<command-message>ctx:ping</command-message>\n<command-name>/ctx:ping</command-name>'

/** The CLI's env: this test's home, none of the runner's own keeper settings. */
function cliEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: '/nonexistent', CTX_KEEPER_HOME: home, ...extra }
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CTX_KEEPER_') && !(k in env)) env[k] = v
  return env
}

type ForkReply = { isAnswered: boolean; usage?: Record<string, number>; reason?: string }

function fakeEngine(home: string, forkReply: ForkReply | (() => never), env: Record<string, string> = {}) {
  const calls: string[] = []
  const $ = {
    plugin: { root: PLUGIN_ROOT },
    session: { id: async () => SID },
    process: {
      run: async (argv: string[], opts: { stdin: string }) => {
        calls.push(argv.at(-1)!)
        const r = spawnSync(argv[0], argv.slice(1), { input: opts.stdin, encoding: 'utf8', env: cliEnv(home, env) })
        return { exitCode: r.status ?? 1, stdout: r.stdout }
      },
    },
    model: {
      fork: async () => {
        calls.push('$.model.fork')
        return typeof forkReply === 'function' ? forkReply() : forkReply
      },
    },
    clock: { after: () => ({ cancel() {} }), now: async () => Date.now() },
    env: { get: async () => undefined },
    fs: { read: async () => { throw new Error('none') } },
    ui: { status: () => {} },
  }
  return { $, calls }
}

/** A session whose last turn ended `agoMin` minutes ago, as `record` leaves it. */
function session(agoMin = 5, env: Record<string, string> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const at = Date.now() - agoMin * MIN
  const transcript = writeTranscript(home, [{ at, read: 90_000, write: 1_000 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, at + 500))
  return { home, config, transcript }
}

const HIT = { isAnswered: true, usage: { input_tokens: 3, cache_read_input_tokens: 91_000, cache_creation_input_tokens: 0, output_tokens: 2 } }

test('manualPing: a fork answers the command and the ledger logs it as manual', async () => {
  const { home } = session()
  const { $, calls } = fakeEngine(home, HIT)
  const text = await manualPing($)
  assert.match(text!, /^cache-keeper: pinged\. Read 91,000 cached tokens, wrote 0; cached till \d\d:\d\d\.$/)
  assert.deepEqual(calls, ['ping-now', '$.model.fork', 'forked'])
  assert.deepEqual(readLedger(home).map((e) => e.event), ['manual-ping'])
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.pingsSoFar, 0)
  assert.equal(s.lastPingHit, null)
})

test('manualPing: a refusal is answered without a fork', async () => {
  const { home } = session(61)
  const { $, calls } = fakeEngine(home, HIT)
  assert.match((await manualPing($))!, /no ping sent: the cache expired at/)
  assert.deepEqual(calls, ['ping-now'])
  assert.ok(loadSession(home, SID)!.gateTurnAt !== undefined, "the refusal's turn is the mod's")
})

test('manualPing from the band: a failed fork is said and closed; a hit re-arms the timer from the press', async () => {
  const failed = session()
  const { $: f } = fakeEngine(failed.home, { isAnswered: false, reason: 'api-error' })
  assert.equal(await manualPing(f, true), 'cache-keeper: no ping sent: the fork failed (api-error).')
  const s = loadSession(failed.home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.gateTurnAt, undefined)

  const hit = session()
  const armed: number[] = []
  const { $: h } = fakeEngine(hit.home, HIT)
  h.clock.after = (ms: number) => {
    armed.push(ms)
    return { cancel() {} }
  }
  assert.match((await manualPing(h, true))!, /^cache-keeper: pinged\./)
  // The first timer is the fork's own timeout; the last one is the next ping, timed from the press.
  assert.equal(armed.at(-1), hit.config.delaySec * 1000)
  assert.equal(loadSession(hit.home, SID)!.gateTurnAt, undefined)

  // The fork went out but `forked` could not run: the ping stays open, so look again once it stops blocking.
  const lost = session()
  const late: number[] = []
  const { $: l } = fakeEngine(lost.home, HIT)
  const run = l.process.run
  l.process.run = async (argv: string[], opts: { stdin: string }) => (argv.at(-1) === 'forked' ? { exitCode: 1, stdout: '' } : run(argv, opts))
  l.clock.after = (ms: number) => {
    late.push(ms)
    return { cancel() {} }
  }
  assert.equal(await manualPing(l, true), 'cache-keeper: pinged, but keeper could not record it.')
  assert.equal(late.at(-1), 150_000)
})

test('manualPing: a failed fork lets the turn reach the model, and its Stop logs the ping as manual', async () => {
  const { home, config, transcript } = session()
  const { $ } = fakeEngine(home, { isAnswered: false, reason: 'api-error' })
  assert.equal(await manualPing($), undefined)
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingTransport, 'turn')
  const at = Date.now()
  writeTranscript(home, [{ at, read: 90_000, write: 200 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, at + 500))
  assert.deepEqual(readLedger(home).map((e) => e.event), ['fork-failed', 'manual-ping'])
  assert.equal(loadSession(home, SID)!.lastPingHit, null)
})

test('manualPing: with forks off, the command turn itself is the ping', async () => {
  const { home } = session(5, { CTX_KEEPER_FORK: '0' })
  const { $, calls } = fakeEngine(home, HIT, { CTX_KEEPER_FORK: '0' })
  assert.equal(await manualPing($), undefined)
  assert.deepEqual(calls, ['ping-now'])
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingManual, true)
})

test('manualPing: a fork that went out is never followed by a model turn, even when the CLI cannot record it', async () => {
  const { home, config, transcript } = session()
  const { $ } = fakeEngine(home, HIT)
  const run = $.process.run
  $.process.run = async (argv, opts) => (argv.at(-1) === 'forked' ? { exitCode: 1, stdout: '' } : run(argv, opts))
  assert.equal(await manualPing($), 'cache-keeper: pinged, but keeper could not record it.')
  // The mod answered that turn, so its Stop is the mod's, even after the slowest fork (2 min here).
  assert.ok(loadSession(home, SID)!.gateTurnAt !== undefined)
  const stopAt = Date.now() + 2 * MIN
  writeTranscript(home, [{ at: stopAt - 500, read: 90_000, write: 0 }])
  const before = loadSession(home, SID)!.lastTurnEndAt
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, stopAt))
  const after = loadSession(home, SID)!
  assert.equal(after.gateTurnAt, undefined)
  assert.equal(after.lastTurnEndAt, before)
})

// --- the gate's turn.step -------------------------------------------------------------

type Handler = (...args: any[]) => any

function hooksOf(): Record<string, Handler> {
  const hooks: Record<string, Handler> = {}
  register(((event: string, ...rest: unknown[]) => {
    hooks[event] = rest.at(-1) as Handler
  }) as any)
  return hooks
}

async function runStep(hooks: Record<string, Handler>, $: unknown, text: string) {
  await hooks['turn.start']($, { turnId: 't1', text }, (e: unknown) => e)
  const yielded: unknown[] = []
  let modelCalled = false
  const next = async function* () {
    modelCalled = true
    yield { kind: 'text', index: 0, text: 'ok' }
    return { answer: 'ok' }
  }
  const gen = hooks['turn.step']($, { turnId: 't1', index: 0, agentId: undefined }, next)
  let r = await gen.next()
  while (!r.done) {
    yielded.push(r.value)
    r = await gen.next()
  }
  return { yielded, result: r.value, modelCalled }
}

test("gate: /ctx:ping's turn is answered by the fork, no model request", async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  const { yielded, result, modelCalled } = await runStep(hooksOf(), $, TAG)
  assert.equal(modelCalled, false)
  assert.match((yielded[0] as any).text, /^cache-keeper: pinged\./)
  assert.equal(result.stopReason, 'end_turn')
})

test('gate: a message that quotes the marker or the tag still reaches the model', async () => {
  const { home } = session()
  const { $, calls } = fakeEngine(home, HIT)
  for (const text of [`what does ${'[cache-keeper:ping]'} do?`, `see ${TAG}`]) {
    const { modelCalled } = await runStep(hooksOf(), $, text)
    assert.equal(modelCalled, true, text)
  }
  assert.ok(!calls.includes('ping-now'))
})

test('gate: AskUserQuestion holds the cache by fork while the person answers, and stops after', async () => {
  const { home } = session(5, { CTX_KEEPER_FORK: '1' })
  const { $, calls } = fakeEngine(home, HIT, { CLAUDE_CODE_ENTRYPOINT: 'cli' })
  const timers: Array<{ ms: number; cancelled: boolean }> = []
  $.clock.after = ((ms: number) => {
    const t = { ms, cancelled: false }
    timers.push(t)
    return { cancel: () => void (t.cancelled = true) }
  }) as any
  let waitingWhileAsked: number | undefined
  const result = await hooksOf()['tool.call']($, { tool: 'AskUserQuestion', questions: [] }, async () => {
    // The question is on screen: the session waits, and a ping is due one delay on.
    waitingWhileAsked = loadSession(home, SID)!.waitingSince
    calls.push('answered')
    return { result: 'yes' }
  })
  assert.deepEqual(result, { result: 'yes' })
  assert.deepEqual(calls, ['wait-start', 'answered', 'wait-end'])
  assert.equal(typeof waitingWhileAsked, 'number')
  assert.equal(timers.length, 1)
  assert.ok(timers[0].ms >= 60_000, `timer at ${timers[0].ms} ms`)
  assert.equal(timers[0].cancelled, true, 'the answer stops the timer')
  assert.equal(loadSession(home, SID)!.waitingSince, undefined)
})

test('gate: a turn.step result that names a 5-minute write makes the status line end five minutes on', async () => {
  const { home } = session()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ band: false }))
  const now = Date.now()
  const shown: Array<string | undefined> = []
  const { $: base } = fakeEngine(home, HIT)
  const $ = {
    ...base,
    clock: { ...base.clock, now: async () => now },
    env: { get: async (k: string) => (k === 'CTX_KEEPER_HOME' ? home : undefined) },
    fs: { read: async (p: string) => readFileSync(p, 'utf8') },
    ui: { status: (t?: string) => void shown.push(t), invalidate: () => {} },
  }
  const hooks = hooksOf()
  const step = async (usage: unknown) => {
    const next = async function* () {
      // The request is in flight for a moment, as a real one is: statusRequested has registered by the time it answers.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { answer: 'ok', usage }
    }
    const gen = hooks['turn.step']($, { turnId: 't2', index: 1, agentId: undefined }, next)
    let r = await gen.next()
    while (!r.done) r = await gen.next()
    await refresh($ as never)
    return shown.at(-1)!
  }
  const hhmm = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`
  assert.ok((await step({ input_tokens: 3 })).startsWith(`◉ ${hhmm(now + 60 * MIN)}`), 'no bucket named: the hour')
  const five = await step({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 700 })
  assert.ok(five.startsWith(`◉ ${hhmm(now + 5 * MIN)}`), five)
  assert.ok(!five.includes('→~'), 'a 5-minute end has no held end')
})

// --- the gate's prompt.submit: who typed ---------------------------------------------

const personFacts = (home: string) => readJson<PersonFacts>(personPath(home, SID))

/** Runs the hook and waits for its writes; `seen` is persons/<id>.json as next(e) found it on disk; `answer` is what next(e) resolves to. */
async function submit(hooks: Record<string, Handler>, $: unknown, home: string, e: Record<string, unknown>, answer?: Record<string, unknown>) {
  const seen: (PersonFacts | undefined)[] = []
  const result = await hooks['prompt.submit']($, { text: 'hi', wait: false, ...e }, async (x: { text: string }) => {
    seen.push(personFacts(home))
    return answer ?? { text: x.text }
  })
  await personWritesSettled()
  return { result, seen }
}

test('gate: a prompt the engine stamps as the person\'s own sets personAt and its command, before next', async () => {
  const { home } = session()
  const { $, calls } = fakeEngine(home, HIT)
  for (const [kind, command] of [['composer', 'handoff'], ['bridge', undefined]] as const) {
    const before = Date.now()
    const { result, seen } = await submit(hooksOf(), $, home, { origin: { kind }, ...(command ? { command: { name: command, args: '' } } : {}) })
    assert.deepEqual(result, { text: 'hi' })
    assert.ok(seen[0]!.personAt! >= before, `${kind}: written before next(e)`)
    const f = personFacts(home)!
    assert.equal(f.personCommand, command, kind)
    assert.equal(f.promptAt, f.personAt, kind)
    assert.equal(f.personEnteredAt, f.personAt, `${kind}: it entered`)
    assert.equal(f.personEnteredCommand, command, kind)
  }
  assert.deepEqual(calls, ['person', 'person', 'person', 'person'], 'through the CLI: the prompt, then its entry')
})

test('gate: a person prompt a hook beneath drops sets personAt but not personEnteredAt', async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  await submit(hooksOf(), $, home, { origin: { kind: 'composer' } })
  const entered = personFacts(home)!.personEnteredAt!
  const { result } = await submit(hooksOf(), $, home, { origin: { kind: 'composer' }, text: 'cold' }, { drop: 'Cold session: NOT sent' })
  assert.deepEqual(result, { drop: 'Cold session: NOT sent' })
  const f = personFacts(home)!
  assert.ok(f.personAt! >= entered)
  assert.equal(f.personEnteredAt, entered, 'the blocked prompt is no person going on here')
})

test("gate: a person prompt whose turn the gate answers itself is taken back to the entry before it", async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  const hooks = hooksOf()
  await submit(hooks, $, home, { origin: { kind: 'composer' }, command: { name: 'deploy', args: '' } })
  const before = personFacts(home)!
  // the gate answers /ctx:status itself: its turn never reaches the model
  await submit(hooks, $, home, { origin: { kind: 'composer' }, text: '/ctx:status', command: { name: 'ctx:status', args: '' } })
  assert.ok(personFacts(home)!.personEnteredAt! > before.personEnteredAt!, 'entered once next(e) resolved')
  const { modelCalled } = await runStep(hooks, $, '/ctx:status')
  await personWritesSettled()
  assert.equal(modelCalled, false)
  const f = personFacts(home)!
  assert.equal(f.personEnteredAt, before.personEnteredAt, 'back to the prompt before')
  assert.equal(f.personEnteredCommand, 'deploy')
  assert.equal(f.personCommand, 'ctx:status', 'personAt still says the person typed it')
})

test('gate: a person prompt that started no turn is not taken back by a later turn the gate refuses', async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  const hooks = hooksOf()
  // a local command: it entered, and no turn of its own follows
  await submit(hooks, $, home, { origin: { kind: 'composer' }, text: '/cost', command: { name: 'cost', args: '' } })
  const entered = personFacts(home)!.personEnteredAt!
  // a peer's message starts the next turn, which the gate answers itself
  await submit(hooks, $, home, { origin: { kind: 'peer' }, text: '/ctx:status' })
  await runStep(hooks, $, '/ctx:status')
  await personWritesSettled()
  assert.equal(personFacts(home)!.personEnteredAt, entered)
})

test('gate: a next(e) that resolves to no object passes through untouched', async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  const result = await hooksOf()['prompt.submit']($, { text: 'hi', wait: false, origin: { kind: 'composer' } }, async () => undefined)
  await personWritesSettled()
  assert.equal(result, undefined)
})

test('gate: a turn the gate lets through keeps its entry; a prompt typed over a running turn is never taken back', async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  const hooks = hooksOf()
  await submit(hooks, $, home, { origin: { kind: 'composer' }, text: 'go on' })
  const entered = personFacts(home)!.personEnteredAt!
  const { modelCalled } = await runStep(hooks, $, 'go on')
  await personWritesSettled()
  assert.equal(modelCalled, true)
  assert.equal(personFacts(home)!.personEnteredAt, entered)
})

test('gate: a peer or a task notification still calls the CLI, as not the person; personAt stays', async () => {
  const { home } = session()
  const { $, calls } = fakeEngine(home, HIT)
  await submit(hooksOf(), $, home, { origin: { kind: 'composer' }, command: { name: 'handoff', args: '' } })
  const typed = personFacts(home)!
  for (const kind of ['peer', 'peer-send-message', 'task-notification', 'unclassified']) {
    const { result } = await submit(hooksOf(), $, home, { origin: { kind } })
    assert.deepEqual(result, { text: 'hi' })
  }
  assert.equal(calls.length, 6, 'the person prompt and its entry, then one call per machine prompt')
  assert.ok(calls.every(c => c === 'person'))
  const f = personFacts(home)!
  assert.equal(f.personAt, typed.personAt)
  assert.equal(f.personCommand, 'handoff')
  assert.ok(f.promptAt >= typed.promptAt)
})

test('gate: a background job\'s launch prompt, stamped as typed, sets no personAt; the next typed one does', async () => {
  const { home } = session()
  const job = tempHome()
  // past PERSON_TEXT_CHARS: the mod sends the head and the length
  const launch = `handoff-prompt: ${'take the offer. '.repeat(1500)}`
  writeFileSync(join(job, 'state.json'), JSON.stringify({ intent: launch }))
  const { $ } = fakeEngine(home, HIT, { CLAUDE_JOB_DIR: job })
  await submit(hooksOf(), $, home, { origin: { kind: 'composer' }, text: launch })
  const launched = personFacts(home)!
  assert.equal(launched.personAt, undefined, 'the launch is no person, even past the gate\'s held-text cap')
  await submit(hooksOf(), $, home, { origin: { kind: 'composer' }, text: 'go on' })
  assert.ok(personFacts(home)!.personAt! >= launched.promptAt)
})

test('gate: two overlapping submits (a person, then a peer) keep personAt', async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  const hooks = hooksOf()
  const [a, b] = await Promise.all([
    submit(hooks, $, home, { origin: { kind: 'composer' }, command: { name: 'handoff', args: '' } }),
    submit(hooks, $, home, { origin: { kind: 'peer' } }),
  ])
  assert.deepEqual(a.result, { text: 'hi' })
  assert.deepEqual(b.result, { text: 'hi' })
  const f = personFacts(home)!
  assert.ok(f.personAt !== undefined, 'personAt kept')
  assert.equal(f.personCommand, 'handoff')
})

test('gate: a failing process run still lets the prompt through unchanged', async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  $.process.run = async () => {
    throw new Error('spawn failed')
  }
  const { result, seen } = await submit(hooksOf(), $, home, { origin: { kind: 'composer' }, command: { name: 'handoff', args: '' } })
  assert.deepEqual(result, { text: 'hi' })
  assert.deepEqual(seen, [undefined], 'next(e) ran once')
  assert.equal(personFacts(home), undefined)
})

test('gate: a hung process run does not stall later prompts - each person write is raced against its own timer', async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  // an engine that ignores timeoutMs and never answers; the module's timer is $.clock.after
  $.process.run = () => new Promise<never>(() => {})
  $.clock.after = ((_ms: number, fn: () => void) => {
    const t = setTimeout(fn, 20)
    return { cancel: () => clearTimeout(t) }
  }) as never
  const hooks = hooksOf()
  const started = Date.now()
  for (let i = 0; i < 2; i++) {
    const { result } = await submit(hooks, $, home, { origin: { kind: 'composer' } })
    assert.deepEqual(result, { text: 'hi' }, `prompt ${i + 1} reached next(e)`)
  }
  assert.ok(Date.now() - started < 2_000, 'the chain advanced on the module timer')
})
