/**
 * The mod side (hooks/statusline.ts) against a faked engine: what it draws in
 * the StatusLine site and the agent rows, what it hands bin/statusline.ts on a
 * measurement, and how a turn's requests become `Δ`.
 */

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { measureSession, renderAgentRow, renderStatusLine, resetForTest, SETTINGS, settingsFrom, statuslineStepAnswered, statuslineTurnStarted, usageSplit } from '../hooks/statusline.ts'

const SID = 'abcdef12-2222-3333-4444-555555555555'
const NOW = Date.parse('2026-11-26T12:00:00Z')
const plain = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '')
const settle = () => new Promise((r) => setTimeout(r, 30))

function engine(env: Record<string, string> = {}, files: Record<string, string> = {}) {
  const runs: Array<{ cmd: string; input: Record<string, unknown> }> = []
  let invalidated = 0
  const $ = {
    env: { get: async (k: string) => ({ HOME: '/Users/u', CLAUDE_CONFIG_DIR: '/Users/u/.claude-work2', ...env })[k] },
    fs: {
      read: async (p: string) => {
        if (p in files) return files[p]!
        throw new Error(`${p} failed: ENOENT`)
      },
      stat: async (p: string) => {
        if (p in files) return { kind: 'file', mtimeMs: 0 }
        throw new Error(`${p} failed: ENOENT`)
      },
    },
    session: {
      id: async () => SID,
      model: async () => 'claude-opus-5-5',
      cwd: async () => '/Users/u/p/repo',
      usage: async () => ({ startedAt: 0, context: { tokens: 47_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 7.05 } }),
      messages: async () => [],
      version: async () => ({ version: '2.1.332' }),
    },
    clock: { now: async () => NOW, every: () => ({ cancel() {} }) },
    process: {
      run: async (argv: string[], init: { stdin: string }) => {
        runs.push({ cmd: argv.at(-1)!, input: JSON.parse(init.stdin) })
        return { exitCode: 0, stdout: '' }
      },
    },
    plugin: { root: '/plugin' },
    ui: { invalidate: () => void invalidated++ },
  }
  return { $: $ as never, runs, invalidated: () => invalidated }
}

const site = (text: string | null = null, maxRows = 5) => ({ props: { text, maxRows, isManaged: false, isWorking: false, columns: 120 } })
const echo = <E>(e: E) => e

beforeEach(() => resetForTest())

test('the first draw passes the engine\'s line, then the mod\'s once its facts are in', async () => {
  const { $, invalidated } = engine()
  assert.equal(renderStatusLine($, site(), echo).props.text, null)
  await settle()
  assert.ok(invalidated() > 0, 'it asks for a redraw')
  assert.equal(plain(renderStatusLine($, site(), echo).props.text!), 'cc:abcdef12 work2 Opus 5.5 · repo · $7.05 ≡47k')
})

test('under a statusLine command of your own, the line goes on the row below its output', async () => {
  const { $ } = engine()
  renderStatusLine($, site(), echo)
  await settle()
  const rows = renderStatusLine($, site('mine\n'), echo).props.text!.split('\n')
  assert.equal(rows[0], 'mine')
  assert.match(plain(rows[1]!), /^cc:abcdef12 /)
  assert.match(plain(renderStatusLine($, site('mine', 1), echo).props.text!), /^cc:abcdef12 /, 'one row to spare: the mod\'s line')
})

test('CTX_STATUSLINE_DISABLED=1: the engine\'s line and the agent rows stay as they are', async () => {
  const { $ } = engine({ CTX_STATUSLINE_DISABLED: '1' })
  renderStatusLine($, site('mine'), echo)
  await settle()
  assert.equal(renderStatusLine($, site('mine'), echo).props.text, 'mine')
  const row = { props: { label: 'reading', model: 'claude-opus-5', tokenCount: 1, startTime: NOW, taskStatus: 'running' } }
  assert.equal(renderAgentRow($, row, echo).props.label, 'reading')
})

test('turned off, the turn\'s events refresh nothing and run no helper', async () => {
  const { $, runs, invalidated } = engine({ CTX_STATUSLINE_DISABLED: '1' })
  renderStatusLine($, site(), echo)
  await settle()
  statuslineTurnStarted($, {})
  statuslineStepAnswered($, {}, { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await settle()
  assert.deepEqual(runs, [])
  assert.equal(invalidated(), 0)
})

test('an engine call that fails under a measurement is swallowed, not left unhandled', async () => {
  const { $ } = engine({ CTX_STATUSLINE_RATE_DIR: '/rl' })
  ;($ as { session: { id: () => Promise<string> } }).session.id = async () => {
    throw new Error('session gone')
  }
  const e = { context: { window: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }], changed: ['rateLimits'] }
  assert.equal(await measureSession($, e, echo), e)
  await settle()
})

test('a look at the folder that a newer one overtook writes nothing when it answers late', async () => {
  const { $ } = engine()
  let clock = NOW
  let release: (rows: unknown[]) => void = () => {}
  const cwds = ['/Users/u/p/old', '/Users/u/p/new']
  let calls = 0
  const e = $ as { clock: { now: () => Promise<number> }; session: { cwd: () => Promise<string>; messages: () => Promise<unknown[]> } }
  e.clock.now = async () => clock
  e.session.cwd = async () => cwds[Math.min(calls, 1)]!
  e.session.messages = () => {
    calls++
    return calls === 1 ? new Promise((r) => (release = r)) : Promise.resolve([])
  }
  renderStatusLine($, site(), echo)
  await settle()
  assert.equal(calls, 1, 'the first look waits on the engine')
  clock += 10_000
  statuslineStepAnswered($, {}, null)
  await settle()
  assert.equal(calls, 2, 'the next look does not wait for it')
  assert.match(plain(renderStatusLine($, site(), echo).props.text!), / new($| · )/)
  release([])
  await settle()
  assert.match(plain(renderStatusLine($, site(), echo).props.text!), / new($| · )/, 'the late answer of the older look is dropped')
})

test('the session record, the account table and the session URL reach the line', async () => {
  const meta = '/Users/u/.claude-work2/sessions-meta/' + SID + '.json'
  const { $ } = engine(
    { CTX_STATUSLINE_META_DIR: 'sessions-meta', CTX_STATUSLINE_ACCOUNTS: '{".claude-work2": "work 🔑work2"}', CTX_STATUSLINE_SESSION_URL: 'http://dash/sessions/{id8}' },
    { [meta]: JSON.stringify({ display_state: 'ready', plan_total: 4, plan_open: 0, plan_changed_at: '2026-11-26T11:00:00Z' }) },
  )
  renderStatusLine($, site(), echo)
  await settle()
  const text = renderStatusLine($, site(), echo).props.text!
  assert.equal(plain(text), 'cc:abcdef12 work 🔑work2 🔔 🏁 4/4 · Opus 5.5 · repo · $7.05 ≡47k')
  assert.ok(text.includes('\x1b]8;;http://dash/sessions/abcdef12\x1b\\'))
  assert.ok(text.includes('\x1b]8;;http://dash/sessions/abcdef12#plan\x1b\\'))
})

test('a measurement with the limits goes to the journal and the barometer, by the config dir\'s name', async () => {
  const { $, runs } = engine({ CTX_STATUSLINE_RATE_DIR: '~/.workflow/state/rate-limits', CTX_STATUSLINE_BAROMETER: '~/.cache/ai-usage-barometer/claude-statusline.json' })
  const limits = [{ kind: 'five_hour', percentUsed: 15, resetsAt: '2026-11-26T22:00:00.000Z' }]
  const e = { context: { tokens: 1, window: 2 }, rateLimits: limits, cost: { usd: 1 }, changed: ['rateLimits', 'cost'] }
  assert.equal(await measureSession($, e, echo), e)
  await settle()
  const rate = runs.find((r) => r.cmd === 'rate')!
  assert.deepEqual(rate.input, { dir: '/Users/u/.workflow/state/rate-limits', account: '.claude-work2', session: SID, at: NOW / 1000, limits })
  const baro = runs.find((r) => r.cmd === 'barometer')!
  assert.equal(baro.input.file, '/Users/u/.cache/ai-usage-barometer/claude-statusline.json')
  assert.equal(baro.input.version, '2.1.332')
})

test('nothing turned on, or the limits unchanged: no helper runs', async () => {
  const off = engine()
  await measureSession(off.$, { context: { window: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }], changed: ['rateLimits'] }, echo)
  const on = engine({ CTX_STATUSLINE_RATE_DIR: '/rl' })
  await measureSession(on.$, { context: { window: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }], changed: ['cost'] }, echo)
  await settle()
  assert.deepEqual([...off.runs, ...on.runs], [])
})

test('a request\'s price splits into the prompt side (fresh, read, written) and the output', () => {
  // claude-opus-5-5: $4 input, $0.2 read, $8 a 1-hour write, $20 output per million.
  const u = { model: 'claude-opus-5-5', input_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000, ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0, output_tokens: 500 }
  const s = usageSplit(u)
  assert.ok(Math.abs(s.inUsd - 0.04) < 1e-9, String(s.inUsd))
  assert.ok(Math.abs(s.outUsd - 0.01) < 1e-9, String(s.outUsd))
  const fiveMin = usageSplit({ ...u, ephemeral_1h_input_tokens: undefined, ephemeral_5m_input_tokens: undefined })
  assert.ok(Math.abs(fiveMin.inUsd - (0.004 + 0.02 + 2000 * 5 / 1e6)) < 1e-9, 'a write with no lifetime is priced as five minutes')
})

test('Δ: every request of the turn, a subagent\'s too, until the next main turn starts it over', async () => {
  const { $ } = engine()
  renderStatusLine($, site(), echo)
  await settle()
  const u = { model: 'claude-opus-5-5', input_tokens: 0, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 0, output_tokens: 10_000 }
  statuslineTurnStarted($, {})
  statuslineStepAnswered($, {}, u)
  statuslineStepAnswered($, { agentId: 'a1' }, u)
  statuslineStepAnswered($, {}, null)
  assert.match(plain(renderStatusLine($, site(), echo).props.text!), /\$7\.05Δ\(20\+40\)¢ ≡47k$/)
  statuslineTurnStarted($, { agentId: 'a1' })
  assert.match(plain(renderStatusLine($, site(), echo).props.text!), /Δ\(20\+40\)¢/, 'a subagent\'s turn does not start it over')
  statuslineTurnStarted($, {})
  await settle()
  assert.doesNotMatch(plain(renderStatusLine($, site(), echo).props.text!), /Δ/)
})

test('an agent row leads with the model, the context against its window and the age', () => {
  const { $ } = engine()
  const row = { props: { label: 'reading files', model: 'claude-opus-5', tokenCount: 105_077, contextWindowSize: 1_000_000, startTime: Date.now() - 12 * 60_000, taskStatus: 'running', columns: 120 } }
  assert.equal(renderAgentRow($, row, echo).props.label, 'opus · 105k/1M · 12м · reading files')
})

test('settings: ~ and relative folders resolve, the config dir is never a worked-on folder', () => {
  const s = settingsFrom({ HOME: '/Users/u', CLAUDE_CONFIG_DIR: '/Users/u/.claude-home/', CTX_STATUSLINE_META_DIR: 'sessions-meta', CTX_STATUSLINE_BRANCH_DIR: '/abs/wb', CTX_STATUSLINE_IGNORE: '~/dotfiles:/tmp', RATE_LIMITS_DIR: '/rl', CTX_STATUSLINE_ACCOUNTS: 'not json' })
  assert.equal(s.configDir, '/Users/u/.claude-home')
  assert.equal(s.metaDir, '/Users/u/.claude-home/sessions-meta')
  assert.equal(s.branchDir, '/abs/wb')
  assert.deepEqual(s.ignore, ['/Users/u/dotfiles', '/tmp'])
  assert.equal(s.rateDir, '/rl')
  assert.equal(s.barometer, undefined)
  assert.deepEqual(s.accounts, {})
  assert.equal(s.cacheDir, '/Users/u/.cache/claude-statusline')
  assert.equal(settingsFrom({ HOME: '/h', XDG_CACHE_HOME: '/x' }).cacheDir, '/x/claude-statusline')
})

test('the README lists every setting', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
  for (const { env } of SETTINGS) assert.ok(readme.includes(`\`${env}\``), env)
})
