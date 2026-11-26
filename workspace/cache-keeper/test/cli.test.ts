/**
 * End to end: the exact commands from hooks/hooks.json, run through bash the
 * way Claude Code runs them, with hook input on stdin, a temp state dir, a fake
 * transcript and a presence override. No Claude Code, no network, any OS.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WAKE_MESSAGE } from '../src/commands.ts'
import { buildHooks, PLUGIN_SCRIPT } from '../src/hooks.ts'
import { readLedger } from '../src/ledger.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { sessionPath } from '../src/state.ts'
import { assistantLine, PLUGIN_ROOT, SID, tempHome, writeTranscript } from './helpers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8'))

function command(event: 'Stop' | 'UserPromptSubmit' | 'SessionEnd', index = 0): string {
  return (hooksJson.hooks[event][0].hooks[index].command as string).replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT)
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
  ms: number
}

function run(cmd: string, input: unknown, env: Record<string, string>): Run {
  const started = Date.now()
  const r = spawnSync('bash', ['-c', cmd], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    // A clean env: the suite may itself run inside a Claude Code session.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: env.CTX_KEEPER_HOME, ...env },
    timeout: 30_000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started }
}

function fresh() {
  const home = tempHome()
  const env = { CTX_KEEPER_HOME: home, CTX_KEEPER_IDLE_SEC: '30', CTX_KEEPER_DELAY_SEC: '0' }
  // The last turn ended just past minAgeSec ago, so a wake right now is due.
  const transcript = writeTranscript(home, [{ at: Date.now() - (T.minAgeSec + 60) * 1000, read: 90_000, write: 500 }])
  const stop = { session_id: SID, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false }
  return { home, env, transcript, stop }
}

test('the plugin\'s hooks/hooks.json runs exactly the command hooks the generator produces', () => {
  const { modules: _, ...commands } = hooksJson
  assert.deepEqual(commands, buildHooks(PLUGIN_SCRIPT))
  const waiter = hooksJson.hooks.Stop[0].hooks[1]
  assert.equal(waiter.asyncRewake, true)
  assert.match(waiter.command, /^\[ "\$CLAUDE_CODE_ENTRYPOINT" = sdk-cli \] \|\| \{ sleep "\$\{CTX_KEEPER_DELAY_SEC:-3000\}"; /)
})

test('--version reports package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const printed = spawnSync(process.execPath, [join(ROOT, 'bin/cache-keeper.ts'), '--version'], { encoding: 'utf8' })
  assert.equal(printed.stdout.trim(), pkg.version, '--version reports the released version')
})

test('e2e: record -> wait+wake pings -> wake turn scored -> human returns -> report -> end', () => {
  const { home, env, stop } = fresh()

  const rec = run(command('Stop', 0), stop, env)
  assert.equal(rec.status, 0, rec.stderr)
  assert.equal(rec.stdout, '')

  // The waiter: sleep 0, then wake. Exit 2 with exactly the wake message —
  // any Node warning here would be read by the model.
  const w = run(command('Stop', 1), stop, env)
  assert.equal(w.status, 2)
  assert.equal(w.stderr, `${WAKE_MESSAGE}\n`)
  assert.deepEqual(readLedger(home).map((e) => e.event), ['ping'])

  // The wake turn's own UserPromptSubmit is ignored.
  const wakePrompt = run(command('UserPromptSubmit'), { session_id: SID, prompt: `Stop hook feedback:\n${WAKE_MESSAGE}` }, env)
  assert.equal(wakePrompt.status, 0)
  assert.equal(wakePrompt.stdout, '', 'UserPromptSubmit stdout would be injected into the context')

  // The Stop closing the wake turn: scored as a hit from the wake turn's own
  // entry, which is necessarily newer than the ping that caused it.
  const wakeTurn = writeTranscript(home, [{ at: Date.now(), read: 90_400, write: 900 }], 'wake-turn.jsonl')
  const closing = run(command('Stop', 0), { ...stop, transcript_path: wakeTurn, stop_hook_active: true }, env)
  assert.equal(closing.status, 0)

  const human = run(command('UserPromptSubmit'), { session_id: SID, prompt: 'continue' }, env)
  assert.equal(human.status, 0)
  assert.equal(human.stdout, '')
  assert.deepEqual(readLedger(home).map((e) => e.event), ['ping', 'wake-hit', 'resume'])

  const report = run(`node ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))} report --json`, '', env)
  assert.equal(report.status, 0, report.stderr)
  const summary = JSON.parse(report.stdout)
  assert.equal(summary.pings, 1)
  assert.equal(summary.hits, 1)
  assert.equal(summary.resumedAfterPing, 1)

  assert.ok(existsSync(sessionPath(home, SID)))
  assert.equal(run(command('SessionEnd'), { session_id: SID, reason: 'exit' }, env).status, 0)
  assert.ok(!existsSync(sessionPath(home, SID)))
})

/** The command line hooks/keepalive.ts runs; it reads the last stdout line as JSON. */
function modCall(cmd: string, input: Record<string, unknown>, env: Record<string, string>): Record<string, unknown> {
  const r = run(`node --disable-warning=ExperimentalWarning ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))} ${cmd}`, { session_id: SID, ...input }, env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `one JSON line: ${r.stdout}`)
  return JSON.parse(lines[0])
}

test('e2e: the mod claims the stretch -> the sleeper stands down -> fork-wake -> forked scores it', () => {
  const { home, env, stop } = fresh()
  run(command('Stop', 0), stop, env)
  assert.deepEqual(modCall('arm', {}, env), { action: 'none', dueInSec: 0 })

  const w = run(command('Stop', 1), stop, env)
  assert.equal(w.status, 0)
  assert.equal(w.stderr, '')

  const f = modCall('fork-wake', {}, env)
  assert.equal(f.action, 'fork')
  assert.match(String(f.prompt), /\[cache-keeper\]/)
  const fork = { isAnswered: true, usage: { input_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 200, output_tokens: 2 } }
  assert.deepEqual(modCall('forked', { fork }, env), { action: 'none', dueInSec: 0 })
  assert.deepEqual(readLedger(home).map((e) => [e.event, e.transport]), [['ping', 'fork'], ['wake-hit', 'fork']])
  assert.deepEqual(modCall('compact-check', { trigger: 'manual' }, env), { action: 'pass' })
})

test('e2e: a refusal exits 0 and says nothing to the model', () => {
  const { home, env, stop } = fresh()
  run(command('Stop', 0), stop, env)
  const w = run(command('Stop', 1), stop, { ...env, CTX_KEEPER_IDLE_SEC: String(T.awaySec + 1) })
  assert.equal(w.status, 0)
  assert.equal(w.stderr, '')
  assert.equal(readLedger(home)[0].reason, 'away')
})

test('e2e: skipIf from config.json vetoes a due ping and sees the session id', () => {
  const { home, env, stop } = fresh()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ skipIf: `[ "$CTX_KEEPER_SESSION_ID" = ${SID} ]` }))
  run(command('Stop', 0), stop, env)
  const w = run(command('Stop', 1), stop, env)
  assert.equal(w.status, 0)
  assert.equal(w.stderr, '')
  assert.equal(readLedger(home)[0].reason, 'skip-if')
})

test('e2e: a stale sleeper exits 0 without a ledger line', () => {
  const { home, env, stop } = fresh()
  const recent = writeTranscript(home, [{ at: Date.now(), read: 90_000 }], 'recent.jsonl')
  run(command('Stop', 0), { ...stop, transcript_path: recent }, env)
  const w = run(command('Stop', 1), stop, env)
  assert.equal(w.status, 0)
  assert.equal(w.stderr, '')
  assert.deepEqual(readLedger(home), [])
})

test('e2e: under `claude -p` (sdk-cli) the waiter returns at once instead of sleeping', () => {
  const { env, stop } = fresh()
  const w = run(command('Stop', 1), stop, { ...env, CTX_KEEPER_DELAY_SEC: '20', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
  assert.equal(w.status, 0)
  assert.ok(w.ms < 10_000, `took ${w.ms} ms`)
})

test('e2e: the delay reaches sleep from the environment', () => {
  const { env, stop } = fresh()
  run(command('Stop', 0), stop, env)
  const w = run(command('Stop', 1), stop, { ...env, CTX_KEEPER_DELAY_SEC: '1' })
  assert.equal(w.status, 2)
  assert.ok(w.ms >= 1000, `took ${w.ms} ms`)
})

/** An hour passes: every mark the cold verdict reads (session record, ledger, transcript) moves `ms` into the past. */
function age(home: string, transcript: string, ms: number): void {
  const shift = (iso: unknown) => (typeof iso === 'string' ? new Date(Date.parse(iso) - ms).toISOString() : iso)
  const record = JSON.parse(readFileSync(sessionPath(home, SID), 'utf8'))
  for (const k of ['lastTurnEndAt', 'cacheAnchorAt', 'lastRequestAt', 'lastPingAt', 'lastHumanAt']) if (typeof record[k] === 'number') record[k] -= ms
  writeFileSync(sessionPath(home, SID), JSON.stringify(record))
  const ledger = join(home, 'ledger.jsonl')
  writeFileSync(ledger, readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), t: shift(JSON.parse(l).t) })).join('\n') + '\n')
  writeFileSync(transcript, readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), timestamp: shift(JSON.parse(l).timestamp) })).join('\n') + '\n')
}

test('e2e: handoff — brief on the last wake, then a cold prompt is held and `2` spawns from the brief', () => {
  const home = tempHome()
  const env = { CTX_KEEPER_HOME: home, CTX_KEEPER_IDLE_SEC: String(T.awaySec + 1), CTX_KEEPER_DELAY_SEC: '0' }
  // closeAfterSpawn off: a real close would SIGTERM the claude this suite may run in.
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ handoff: { enabled: true, closeAfterSpawn: false, spawnCommand: 'echo "spawned from $CTX_KEEPER_BRIEF"' } }),
  )
  const transcript = writeTranscript(home, [{ at: Date.now() - (T.minAgeSec + 60) * 1000, read: 150_000, write: 500 }])
  const stop = { session_id: SID, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false }
  run(command('Stop', 0), stop, env)
  const w = run(command('Stop', 1), stop, env)
  assert.equal(w.status, 2)
  const brief = w.stderr.match(/to (\S+\.md) with the Write tool/)![1]
  writeFileSync(brief, `Goal: e2e.\n${'State of the work. '.repeat(30)}`)
  writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}${assistantLine({ at: Date.now(), read: 150_500, write: 300 })}\n`)
  run(command('Stop', 0), { ...stop, stop_hook_active: true }, env)
  age(home, transcript, 61 * 60_000)

  const prompt = { session_id: SID, transcript_path: transcript, hook_event_name: 'UserPromptSubmit' }
  const held = run(command('UserPromptSubmit'), { ...prompt, prompt: 'where were we?' }, env)
  assert.equal(held.status, 0)
  const menu = JSON.parse(held.stdout)
  assert.equal(menu.decision, 'block')
  assert.match(menu.reason, /gone cold/)
  const two = run(command('UserPromptSubmit'), { ...prompt, prompt: '2' }, env)
  const done = JSON.parse(two.stdout)
  assert.equal(done.decision, 'block')
  assert.match(done.reason, /continued in a new session\.\nspawned from .*-continue\.md/)
  assert.ok(readLedger(home).some((e) => e.event === 'handoff-new'))
})


test('cli: status --json answers warmth and presence for one session; a bad call is exit 64', () => {
  const home = tempHome()
  const env = { CTX_KEEPER_HOME: home }
  const now = Date.now()
  const transcript = writeTranscript(home, [{ at: now - 10 * 60_000, read: 90_000, write: 500 }])
  run(command('Stop', 0), { session_id: SID, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false }, env)
  mkdirSync(join(home, 'persons'), { recursive: true })
  writeFileSync(join(home, 'persons', `${SID}.json`), JSON.stringify({ promptAt: now - 11 * 60_000, personAt: now - 11 * 60_000 }))
  const cli = (args: string) => run(`node ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))} ${args}`, '', env)
  const r = cli(`status --json ${SID} --transcript ${JSON.stringify(transcript)}`)
  assert.equal(r.status, 0, r.stderr)
  const s = JSON.parse(r.stdout)
  assert.equal(s.sessionId, SID)
  assert.equal(s.warm, true)
  assert.ok(s.coldAt > now && s.lastWarmAt <= now, r.stdout)
  assert.deepEqual(s.presence, { promptAt: now - 11 * 60_000, personAt: now - 11 * 60_000 })
  const { now: _, ...unknown } = JSON.parse(cli('status --json no-such').stdout)
  assert.deepEqual(unknown, { sessionId: 'no-such', warm: false, cold: false }, 'nothing known: neither warm nor cold, no presence')
  for (const bad of ['status', `status ${SID}`, `status --json ${SID} --transcript`]) assert.equal(cli(bad).status, 64, bad)
})

test('e2e: garbage on stdin never fails a hook', () => {
  const { env } = fresh()
  for (const sub of ['record', 'wake', 'touch', 'end']) {
    const r = run(`node ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))} ${sub}`, '{not json', env)
    assert.equal(r.status, 0, `${sub}: ${r.stderr}`)
    assert.equal(r.stdout, '')
  }
})

test('cli: --help, --version, install-snippet, unknown command', () => {
  const env = { CTX_KEEPER_HOME: tempHome() }
  const bin = `node ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))}`
  assert.match(run(`${bin} --help`, '', env).stdout, /record/)
  assert.match(run(`${bin} --version`, '', env).stdout, /^\d+\.\d+\.\d+\n$/)
  const snippet = JSON.parse(run(`${bin} install-snippet`, '', env).stdout)
  assert.equal(snippet.hooks.Stop[0].hooks[1].asyncRewake, true)
  assert.ok(snippet.hooks.Stop[0].hooks[1].command.includes(`sh '${join(ROOT, 'bin/cache-keeper.sh')}' wake`))
  assert.equal(snippet.hooks.SessionStart[0].hooks[0].command, `sh '${join(ROOT, 'bin/cache-keeper.sh')}' check`)
  assert.equal(run(`${bin} nope`, '', env).status, 64)
})
