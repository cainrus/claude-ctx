import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runBlockIf, slashCommandOf, type BlockIfAnswer, type BlockIfInput } from '../src/cold-stop.ts'
import { end, gate, record, touch } from '../src/commands.ts'
import { briefPath, recordPath } from '../src/handoff.ts'
import { readLedger } from '../src/ledger.ts'
import { takeNotices } from '../src/notices.ts'
import { loadSession } from '../src/state.ts'
import { assistantLine, configFor, makeCtx, MIN, SID, tempHome, writeTranscript } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const ON = { CTX_KEEPER_COLD_STOP: '1' }

/** A session whose last turn ended at T0 with a 150k context. */
function session(env: Record<string, string> = ON, ctx = 150_000) {
  const home = tempHome()
  const config = configFor(home, env)
  const transcript = writeTranscript(home, [{ at: T0, read: ctx, write: 500 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  return { home, config, transcript }
}

/** touch (or gate) at `now`; `out` is what it printed, parsed. */
function send(s: ReturnType<typeof session>, prompt: string, now: number, opts: { gate?: boolean; blockIf?: (i: BlockIfInput) => BlockIfAnswer } = {}) {
  const out: any[] = []
  const ctx = { ...makeCtx(s.config, now), stdout: (t: string) => out.push(JSON.parse(t)), env: {}, ...(opts.blockIf ? { blockIf: opts.blockIf } : {}) }
  const input = { session_id: SID, transcript_path: s.transcript, prompt, ...(opts.gate ? { gate_turn: true } : {}) }
  if (opts.gate) gate(input, ctx)
  else touch(input, ctx)
  const block = out.find((o) => o.decision === 'block')
  return { out, block, context: out.find((o) => o.hookSpecificOutput)?.hookSpecificOutput.additionalContext as string | undefined }
}

const COLD = T0 + 70 * MIN

test('cold stop: off by default - a cold prompt goes through', () => {
  const s = session({})
  assert.equal(send(s, 'where were we?', COLD).block, undefined)
})

test('cold stop: the first prompt into a cold session is held with its price; it never ran', () => {
  const s = session()
  const before = loadSession(s.home, SID)!
  const { block } = send(s, 'where were we?', COLD)
  assert.match(block.reason, /gone cold \(idle 1h 10m\): this prompt was NOT sent/)
  assert.match(block.reason, /re-send ~151k tokens \(≈ \$\d+\.\d\d\)/)
  assert.match(block.reason, /send it again within 15 min\./)
  const after = loadSession(s.home, SID)!
  assert.equal(after.lastHumanAt, before.lastHumanAt, 'a held prompt never ran')
  assert.equal(after.coldStopAt, COLD)
  assert.deepEqual(readLedger(s.home).filter((e) => e.event.startsWith('cold')).map((e) => e.event), ['cold-stop'])
})

test('cold stop: anything sent within ackSec of the stop goes through, a follow-up too; later the stop holds again', () => {
  const s = session()
  send(s, 'where were we?', COLD)
  assert.equal(send(s, 'go on anyway', COLD + 2 * MIN).block, undefined)
  assert.equal(send(s, 'and also this', COLD + 2 * MIN + 5_000).block, undefined, 'the resent turn still runs: the cache reads cold')
  assert.equal(loadSession(s.home, SID)!.coldStopAt, COLD, 'the ack keeps its window')
  assert.ok(readLedger(s.home).some((e) => e.event === 'cold-go-on'))
  const late = session()
  send(late, 'where were we?', COLD)
  assert.ok(send(late, 'go on', COLD + 16 * MIN).block, 'past the window: held again')
})

test('cold stop: warm, no turn yet, or too cheap - never held', () => {
  const s = session()
  assert.equal(send(s, 'next', T0 + 30 * MIN).block, undefined, 'warm')
  const fresh = { home: tempHome(), config: configFor(tempHome(), ON), transcript: '' }
  fresh.config = configFor(fresh.home, ON)
  assert.equal(send(fresh, 'hello', COLD).block, undefined, 'no turn yet')
  const small = session(ON, 2_000)
  assert.equal(send(small, 'next', COLD).block, undefined, 'a cold turn under minUsd')
})

test('cold stop: commands that hand off or close, keeper\'s own, machine messages and wakes go through; another command is held', () => {
  const passing = [
    '/handoff move it',
    '/workflow:handoff',
    '<command-message>handoff</command-message>\n<command-name>/handoff</command-name>',
    '/session-end',
    '/ctx:report',
    'Another Claude session sent a message: hi',
    'The vault plugin sent a message: indexed',
    '<task-notification>done</task-notification>',
    '<cross-session-message from="x">hi</cross-session-message>',
    '[cache-keeper] Prompt-cache keep-alive.',
  ]
  for (const prompt of passing) assert.equal(send(session(), prompt, COLD).block, undefined, prompt)
  for (const prompt of ['/deploy now', '<command-message>x</command-message>\n<command-name>/improve-code</command-name>', '!ls']) {
    assert.ok(send(session(), prompt, COLD).block, prompt)
  }
})

test('gate: a launch prompt cut at the gate\'s 4000 characters is still the launch', () => {
  const s = session()
  const job = tempHome()
  const launch = `handoff-prompt: ${'take the offer. '.repeat(400)}`
  writeFileSync(join(job, 'state.json'), JSON.stringify({ intent: launch }))
  const out: any[] = []
  const ctx = { ...makeCtx(s.config, COLD), stdout: (t: string) => out.push(JSON.parse(t)), env: { CLAUDE_JOB_DIR: job } }
  gate({ session_id: SID, transcript_path: s.transcript, prompt: launch.slice(0, 4000), gate_turn: true }, ctx)
  assert.equal(out.find((o) => o.decision === 'block'), undefined)
})

test('cold stop: a background job\'s launch prompt goes through', () => {
  const s = session()
  const job = tempHome()
  writeFileSync(join(job, 'state.json'), JSON.stringify({ intent: 'take the offer' }))
  const out: any[] = []
  const ctx = { ...makeCtx(s.config, COLD), stdout: (t: string) => out.push(JSON.parse(t)), env: { CLAUDE_JOB_DIR: job } }
  touch({ session_id: SID, transcript_path: s.transcript, prompt: 'take the offer' }, ctx)
  assert.equal(out.find((o) => o.decision === 'block'), undefined)
})

test('cold stop: passCommands from config.json replace the defaults', () => {
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ coldStop: { enabled: true, passCommands: ['/deploy'] } }))
  const config = configFor(home)
  const transcript = writeTranscript(home, [{ at: T0, read: 150_000, write: 500 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  const s = { home, config, transcript }
  assert.equal(send(s, '/deploy now', COLD).block, undefined)
  assert.ok(send(s, '/handoff', COLD).block, 'the defaults are replaced, not extended')
})

test('cold stop: a ready handoff brief answers with its menu instead - one stop', () => {
  const s = session({ ...ON, CTX_KEEPER_HANDOFF: '1' })
  mkdirSync(join(s.home, 'handoffs'), { recursive: true })
  writeFileSync(briefPath(s.home, SID), 'brief')
  writeFileSync(recordPath(s.home, SID), JSON.stringify({ sessionId: SID, status: 'ready', requestedAt: T0, preCtx: 150_000, transcriptPath: s.transcript, briefPath: briefPath(s.home, SID) }))
  const { out, block } = send(s, 'back', COLD)
  assert.equal(out.length, 1)
  assert.match(block.reason, /A handoff brief was written/)
  assert.equal(loadSession(s.home, SID)!.coldStopAt, undefined)
})

test('blockIf: asked on warm prompts too; exit 2 holds with its reason and gets the cold lines when keeper would stop', () => {
  const seen: BlockIfInput[] = []
  const stop = (i: BlockIfInput): BlockIfAnswer => {
    seen.push(i)
    return { kind: 'stop', reason: `work went elsewhere${i.coldLines ? `\n${i.coldLines.join('\n')}` : ''}` }
  }
  const s = session()
  assert.equal(send(s, 'warm one', T0 + 10 * MIN, { blockIf: stop }).block.reason, 'work went elsewhere')
  assert.deepEqual({ cold: seen[0].cold, lines: seen[0].coldLines }, { cold: false, lines: undefined })
  const cold = send(s, 'cold one', COLD, { blockIf: stop }).block.reason
  assert.match(cold, /^work went elsewhere\ncache-keeper: this session's prompt cache has gone cold/)
  assert.equal(seen[1].prompt, 'cold one')
  assert.ok(readLedger(s.home).some((e) => e.event === 'cold-stop' && e.detail === 'block-if'))
  assert.equal(send(s, 'resend', COLD + MIN).block, undefined, 'the price was shown: the resend is not held by keeper too')
})

test('blockIf: exit 3 lets a prompt through with its context once the price was shown; never past a price nobody showed', () => {
  const passing = (): BlockIfAnswer => ({ kind: 'pass', context: '[handoff] the person went on here' })
  const s = session()
  assert.match(send(s, 'cold one', COLD, { blockIf: passing }).block.reason, /gone cold/, 'keeper\'s stop was due: it holds')
  const pass = send(s, 'again', COLD + MIN, { blockIf: passing })
  assert.equal(pass.block, undefined)
  assert.match(pass.context!, /the person went on here/)
  const warm = send(session(), 'warm one', T0 + 10 * MIN, { blockIf: passing })
  assert.match(warm.context!, /went on here/, 'warm: nothing owed')
  assert.ok(send(session(), 'cold one', COLD, { blockIf: () => ({ kind: 'none' }) }).block, 'no answer: keeper\'s own stop')
})

test('blockIf: a hold that does not carry the price leaves keeper\'s stop owed on the resend', () => {
  const s = session()
  let n = 0
  const handed = (i: BlockIfInput): BlockIfAnswer => (n++ === 0 ? { kind: 'stop', reason: 'work went to cc:12345678' } : { kind: 'none' })
  assert.equal(send(s, 'cold one', COLD, { blockIf: handed }).block.reason, 'work went to cc:12345678')
  assert.match(send(s, 'resend', COLD + MIN, { blockIf: handed }).block.reason, /gone cold/, 'the price is still shown once')
})

test('gate: a prompt the UserPromptSubmit hook let through is not held again at its first request; /compact into a cold cache is', () => {
  const s = session()
  send(s, 'where were we?', COLD)
  send(s, 'go on anyway', COLD + MIN)
  let asked = 0
  const { block } = send(s, 'go on anyway', COLD + MIN + 1_000, { gate: true, blockIf: () => (asked++, { kind: 'none' }) })
  assert.equal(block, undefined)
  assert.equal(asked, 0, 'blockIf was asked once, by the prompt hook')
  const c = session()
  const held = send(c, '/compact', COLD, { gate: true })
  assert.match(held.block.reason, /this command was NOT sent[\s\S]*run it again within 15 min/)
  assert.equal(loadSession(c.home, SID)!.gateTurnAt, COLD, 'the gate answered the turn')
})

test('gate: the prompt hook\'s stamp spares only its own prompt, once, within 2 min; a slash command matches by name', () => {
  const s = session()
  send(s, 'quick question', T0 + 10 * MIN)
  // the turn was interrupted: no Stop, lastHumanAt stays newer than lastTurnEndAt
  assert.ok(send(s, '/compact', T0 + 10 * MIN + 30_000, { gate: true }).block === undefined, 'warm: nothing to hold')
  assert.ok(send(s, '/compact', COLD, { gate: true }).block, 'an interrupted turn exempts nothing: cold, the gate holds it')
  const c = session()
  let n = 0
  const count = (): BlockIfAnswer => (n++, { kind: 'none' })
  send(c, '/deploy now', T0 + 10 * MIN, { blockIf: count })
  send(c, '<command-message>deploy</command-message>\n<command-name>/deploy</command-name>', T0 + 10 * MIN + 1_000, { gate: true, blockIf: count })
  assert.equal(n, 1, 'the engine-tagged form is the same command: asked once')
  // the stamp spares only its own prompt's first request: a blockIf that counts its asks tells
  const t = session()
  let asks = 0
  const counting = (): BlockIfAnswer => (asks++, { kind: 'none' })
  send(t, 'warm prompt', T0 + 10 * MIN, { blockIf: counting })
  assert.ok(loadSession(t.home, SID)!.promptHookPassed, 'stamped')
  send(t, 'warm prompt', T0 + 10 * MIN + 1_000, { gate: true, blockIf: counting })
  assert.equal(asks, 1, 'its own first request is not asked again')
  assert.equal(loadSession(t.home, SID)!.promptHookPassed, undefined, 'spent')
  send(t, 'warm prompt', T0 + 10 * MIN + 2_000, { gate: true, blockIf: counting })
  assert.equal(asks, 2, 'spent: the next gate ask is asked')
  send(t, 'go', T0 + 11 * MIN, { blockIf: counting })
  send(t, 'go on', T0 + 11 * MIN + 1_000, { gate: true, blockIf: counting })
  assert.equal(asks, 4, 'another text is another prompt')
  send(t, 'later', T0 + 12 * MIN, { blockIf: counting })
  send(t, 'later', T0 + 15 * MIN, { gate: true, blockIf: counting })
  assert.equal(asks, 6, 'expired after 2 min')
})

test('cold stop: the ack ends with the turn it let through; a later cold prompt is held again', () => {
  // the resent turn ran and ended (a Stop) on a 5 min bucket, then the cache went cold again within ackSec
  const five = session({ ...ON }, 150_000)
  send(five, 'where were we?', COLD)
  send(five, 'go on', COLD + MIN)
  writeFileSync(five.transcript, `${readFileSync(five.transcript, 'utf8')}${assistantLine({ at: COLD + 2 * MIN, read: 150_000, write: 500, split: { m5: 500 } })}\n`)
  record({ session_id: SID, transcript_path: five.transcript }, makeCtx(five.config, COLD + 2 * MIN + 500))
  assert.ok(send(five, 'ten minutes on', COLD + 10 * MIN).block, 'a 5 min bucket: cold again inside the old ack window')
})

test('blockIf: exit 3 skips the handoff menu only once a stop showed the price', () => {
  const s = session({ CTX_KEEPER_HANDOFF: '1' })
  mkdirSync(join(s.home, 'handoffs'), { recursive: true })
  writeFileSync(briefPath(s.home, SID), 'brief')
  writeFileSync(recordPath(s.home, SID), JSON.stringify({ sessionId: SID, status: 'ready', requestedAt: T0, preCtx: 150_000, transcriptPath: s.transcript, briefPath: briefPath(s.home, SID) }))
  const { block } = send(s, 'back', COLD, { blockIf: () => ({ kind: 'pass' }) })
  assert.match(block.reason, /A handoff brief was written/, 'coldStop off: the menu is the only price')
  assert.equal(loadSession(s.home, SID)!.coldStopAt, undefined, 'a pass marks no price as shown')
})

test('cold stop: a person\'s `[` or `<` prompt is held, kebab-case too; keeper\'s wake and the engine\'s envelopes are not', () => {
  const persons = ['[Image #1] what is this?', '[ ] fix the tests', '<div> why is it red?', '<bash-input>ls</bash-input>', '[wip-fix] tests fail', '<my-component> does not render']
  for (const prompt of persons) assert.ok(send(session(), prompt, COLD).block, prompt)
  for (const prompt of ['[cache-keeper:other] x', '<local-command-stdout>ok</local-command-stdout>', '<system-reminder>x</system-reminder>']) {
    assert.equal(send(session(), prompt, COLD).block, undefined, prompt)
  }
})

test('blockIf: never asked for a machine\'s prompt, so it can never hold one', () => {
  let asked = 0
  const stop = (): BlockIfAnswer => (asked++, { kind: 'stop', reason: 'held' })
  for (const prompt of ['Another Claude session sent a message: hi', '<task-notification>x</task-notification>', '<local-command-stdout>ok</local-command-stdout>']) {
    assert.equal(send(session(), prompt, COLD, { blockIf: stop }).block, undefined, prompt)
  }
  assert.equal(asked, 0)
})

test('blockIf: asked when the handoff menu lets a prompt through, keeper\'s own stop is not', () => {
  const s = session({ ...ON, CTX_KEEPER_HANDOFF: '1' })
  mkdirSync(join(s.home, 'handoffs'), { recursive: true })
  writeFileSync(briefPath(s.home, SID), 'brief')
  writeFileSync(recordPath(s.home, SID), JSON.stringify({ sessionId: SID, status: 'ready', requestedAt: T0, preCtx: 150_000, transcriptPath: s.transcript, briefPath: briefPath(s.home, SID) }))
  let asked = 0
  const { block } = send(s, 'warm and back', T0 + 10 * MIN, { blockIf: () => (asked++, { kind: 'stop', reason: 'work went elsewhere' }) })
  assert.equal(asked, 1)
  assert.equal(block.reason, 'work went elsewhere')
  assert.equal(JSON.parse(readFileSync(recordPath(s.home, SID), 'utf8')).status, 'ready', 'asked before the menu: the brief is not burned')
})

test('cold stop: a session resumed after SessionEnd (a fresh record) is held by the size its transcript shows', () => {
  const s = session()
  end({ session_id: SID }, makeCtx(s.config, T0 + 1_000))
  const { block } = send(s, 'claude --resume, an hour later', COLD)
  assert.match(block.reason, /re-send ~151k tokens/)
})

test('cold stop: cold-go-on is logged once per stop, not for each follow-up; a short window reads in seconds', () => {
  const s = session()
  send(s, 'where were we?', COLD)
  send(s, 'go on', COLD + MIN)
  send(s, 'and this', COLD + MIN + 5_000)
  assert.equal(readLedger(s.home).filter((e) => e.event === 'cold-go-on').length, 1)
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ coldStop: { enabled: true, ackSec: 30 } }))
  const config = configFor(home)
  const transcript = writeTranscript(home, [{ at: T0, read: 150_000, write: 500 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  assert.match(send({ home, config, transcript }, 'x', COLD).block.reason, /again within 30 s\./)
})

test('coldStop.ackSec 0 is no setting: the default window stands', () => {
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ coldStop: { enabled: true, ackSec: 0 } }))
  assert.equal(configFor(home).coldStop.ackSec, 900)
})

test('gate: blockIf\'s exit-3 context reaches the model with the next typed prompt', () => {
  const s = session()
  assert.equal(send(s, '/deploy', T0 + 10 * MIN, { gate: true, blockIf: () => ({ kind: 'pass', context: '[handoff] went on here' }) }).block, undefined)
  assert.deepEqual(takeNotices(s.home, SID, T0 + 11 * MIN), ['[handoff] went on here'])
})

test('cold stop: keeper switched off (enabled: false) holds nothing and asks no blockIf', () => {
  let asked = 0
  const s = session({ ...ON, CTX_KEEPER_DISABLED: '1' })
  assert.equal(send(s, 'cold one', COLD, { blockIf: () => (asked++, { kind: 'stop', reason: 'x' }) }).block, undefined)
  assert.equal(asked, 0)
})

test('cold stop: config cacheTtlSec 300 stands in for a bucket the record never learned', () => {
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ cacheTtlSec: 300, coldStop: { enabled: true } }))
  const config = configFor(home)
  const transcript = writeTranscript(home, [{ at: T0, read: 150_000, write: 500 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  assert.equal(loadSession(home, SID)!.cacheTtlSec, undefined, 'no split in the usage: no bucket learned')
  assert.ok(send({ home, config, transcript }, 'ten minutes later', T0 + 10 * MIN).block)
})

test('slashCommandOf: typed or tagged, never a word mid-text', () => {
  assert.equal(slashCommandOf('/handoff now'), 'handoff')
  assert.equal(slashCommandOf('  /ns:cmd'), 'ns:cmd')
  assert.equal(slashCommandOf('<command-message>x</command-message>\n<command-name>/ns:x</command-name>'), 'ns:x')
  assert.equal(slashCommandOf('see /handoff'), undefined)
  assert.equal(slashCommandOf('quote: <command-name>/x</command-name>'), undefined)
})

test('runBlockIf: the shell command reads the facts on stdin; 2 holds, 3 passes, anything else is no answer', () => {
  const input: BlockIfInput = { session_id: SID, prompt: 'p', cold: true }
  assert.deepEqual(runBlockIf('read l; echo "held: $CTX_KEEPER_SESSION_ID $(echo "$l" | grep -c cold)"; exit 2', input), { kind: 'stop', reason: `held: ${SID} 1` })
  assert.deepEqual(runBlockIf('exit 3', input), { kind: 'pass' })
  assert.deepEqual(runBlockIf('echo ctx; exit 3', input), { kind: 'pass', context: 'ctx' })
  assert.deepEqual(runBlockIf('exit 2', input), { kind: 'none' }, 'a hold with no reason is no hold')
  assert.deepEqual(runBlockIf('exit 0', input), { kind: 'none' })
  assert.deepEqual(runBlockIf('sleep 5', input, 200), { kind: 'none' }, 'a timeout is no answer')
  assert.deepEqual(runBlockIf('echo held; exit 2', { ...input, prompt: 'a'.repeat(1_000_000) }), { kind: 'stop', reason: 'held' }, 'a huge prompt the command never reads')
  assert.deepEqual(runBlockIf('exit 2\0', input), { kind: 'none' }, 'a command spawnSync refuses is no answer, never a throw')
  const started = Date.now()
  assert.deepEqual(runBlockIf('sleep 5 | cat', input, 300), { kind: 'none' })
  assert.ok(Date.now() - started < 3_000, 'a grandchild holding the output does not outlast the timeout')
})
