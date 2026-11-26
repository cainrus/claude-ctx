/**
 * hooks/ctx.ts, the plugin's one module, registered against a recording `on`:
 * every event once (the engine takes one hook per event per plugin), and the
 * two shared events still run cache-keeper's part as before and the status
 * line's after it. The engine is faked; keeper's gate answers through a fake
 * CLI run.
 */

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from '../hooks/ctx.ts'
import { resetForTest } from '../workspace/statusline/hooks/statusline.ts'

type Hook = (...args: unknown[]) => unknown
const SID = 'abcdef12-2222-3333-4444-555555555555'

function hooks(): Map<string, Hook> {
  const got = new Map<string, Hook>()
  const on = (event: string, a: unknown, b?: unknown) => {
    const key = b === undefined ? event : `${event} ${JSON.stringify(a)}`
    assert.equal(got.has(key), false, `${key} registered twice`)
    got.set(key, (b ?? a) as Hook)
  }
  register(on as never, {} as never)
  return got
}

function engine(gate: { decision?: string; reason?: string } = {}) {
  const runs: string[] = []
  const $ = {
    plugin: { root: '/plugin' },
    env: { get: async (k: string) => ({ HOME: '/Users/u', CLAUDE_CONFIG_DIR: '/Users/u/.claude-home' })[k] },
    fs: {
      read: async (p: string) => {
        throw new Error(`${p} failed: ENOENT`)
      },
      stat: async (p: string) => {
        throw new Error(`${p} failed: ENOENT`)
      },
    },
    session: {
      id: async () => SID,
      model: async () => 'claude-opus-5-5',
      cwd: async () => '/Users/u/p/repo',
      usage: async () => ({ startedAt: 0, context: { tokens: 10_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 1 } }),
      messages: async () => [],
      version: async () => ({ version: 'x' }),
    },
    clock: { now: async () => Date.now(), every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv.at(-1)!)
        return { exitCode: 0, stdout: argv.at(-1) === 'gate' && gate.decision ? JSON.stringify(gate) : '' }
      },
    },
    ui: { status: () => {}, invalidate: () => {} },
  }
  return { $, runs }
}

const settle = () => new Promise((r) => setTimeout(r, 30))
const plain = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '')

async function drain(gen: AsyncGenerator<unknown, unknown>): Promise<{ chunks: unknown[]; result: unknown }> {
  const chunks: unknown[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

beforeEach(() => resetForTest())

test('every event once: each package its own, the shared two from the root', () => {
  assert.deepEqual([...hooks().keys()].sort(), [
    'session.compact',
    'session.measure',
    'session.start',
    'tool.call {"tool":"AskUserQuestion"}',
    'turn.complete',
    'turn.start',
    'turn.step',
    'ui.render {"component":"AbovePrompt"}',
    'ui.render {"component":"AgentRow"}',
    'ui.render {"component":"StatusLine"}',
  ])
})

test('a turn the gate refuses never reaches the model, and adds nothing to Δ', async () => {
  const h = hooks()
  const { $ } = engine({ decision: 'block', reason: 'the menu' })
  await h.get('turn.start')!($, { turnId: 't1', text: '!ls' }, (e: unknown) => e)
  let asked = 0
  const next = async function* () {
    asked++
    return { usage: null }
  }
  const { chunks, result } = await drain(h.get('turn.step')!($, { turnId: 't1', index: 0 }, next) as AsyncGenerator<unknown, unknown>)
  assert.equal(asked, 0)
  assert.deepEqual(chunks, [{ kind: 'text', index: 0, text: 'the menu' }, { kind: 'stop', stopReason: 'end_turn', usage: null }])
  assert.equal((result as { answer: string }).answer, 'the menu')
})

test('a turn the gate lets through runs the request once, and its price reaches the status line', async () => {
  const h = hooks()
  const { $, runs } = engine()
  const draw = h.get('ui.render {"component":"StatusLine"}')!
  draw($, { props: { text: null, maxRows: 5 } }, (e: unknown) => e)
  await settle()
  await h.get('turn.start')!($, { turnId: 't2', text: 'hello' }, (e: unknown) => e)
  const usage = { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 10_000, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 0 }
  let asked = 0
  const next = async function* () {
    asked++
    yield { kind: 'text', index: 0, text: 'hi' }
    return { turnId: 't2', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  }
  const { result } = await drain(h.get('turn.step')!($, { turnId: 't2', index: 0 }, next) as AsyncGenerator<unknown, unknown>)
  assert.equal(asked, 1)
  assert.equal((result as { usage: unknown }).usage, usage)
  assert.ok(runs.includes('gate'), 'keeper asked its gate first')
  const line = (draw($, { props: { text: null, maxRows: 5 } }, (e: unknown) => e) as { props: { text: string } }).props.text
  assert.match(plain(line), /Δ\(10\+20\)¢/)
})
