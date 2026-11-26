/**
 * The line as hooks/line.ts draws it: the segments, their order, colours and
 * links, from facts alone. The forms mirror what statusline.sh drew, but for
 * the spend, which follows the engine's real context window.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountOf, lineText, modelName, planOf, planText, spendText, stateOf, totalText, type Facts } from '../hooks/line.ts'

const SID = '11111111-2222-3333-4444-555555555555'
const OSC8 = /\x1b\]8;;([^\x1b]*)\x1b\\/g
const plain = (s: string) => s.replace(OSC8, '').replace(/\x1b\[[0-9;]*m/g, '')
const links = (s: string) => [...s.matchAll(OSC8)].map((m) => m[1]!).filter(Boolean)

test('order: cc:<id8> account glyph, then plan · branch · model · dir · spend', () => {
  const f: Facts = {
    sessionId: SID,
    account: { label: 'home', foreign: false },
    state: 'working',
    plan: { total: 5, open: 3, ageSec: 600 },
    branch: 'main',
    dirty: 2,
    ahead: 1,
    model: 'Opus 5.5',
    dir: 'repo',
    spend: { totalUsd: 7.05, turn: { inUsd: 0.1, outUsd: 0.4 }, context: { tokens: 47_000, window: 1_000_000 } },
  }
  assert.equal(plain(lineText(f)), 'cc:11111111 home ⏳ 📋 2/5 · main±2↑1 · Opus 5.5 · repo · $7.05Δ(10+40)¢ ≡47k')
})

test('cc: links to the session page, the plan glyph to its plan card; no URL, no link', () => {
  const href = 'http://dash/sessions/11111111'
  const f: Facts = { sessionId: SID, sessionHref: href, plan: { total: 2, open: 1 } }
  assert.deepEqual(links(lineText(f)), [href, `${href}#plan`])
  assert.deepEqual(links(lineText({ sessionId: SID, plan: { total: 2, open: 1 } })), [])
})

test('a session id that is not hex gets no cc: token', () => {
  assert.equal(plain(lineText({ sessionId: 'not-a-hex-id', model: 'Opus' })), 'Opus')
})

test('an empty model does not shift the folder into its place', () => {
  assert.equal(plain(lineText({ sessionId: SID, model: '', dir: 'some dir' })), 'cc:11111111 some dir')
})

test('a branch repeating the folder name (case aside) is dropped; its marks move to the folder', () => {
  assert.equal(plain(lineText({ branch: 'LEONWEB-1-x', dirty: 1, model: 'Opus', dir: 'leonweb-1-x' })), 'Opus · leonweb-1-x±1')
  assert.equal(plain(lineText({ branch: 'feat-x', model: 'Opus', dir: 'repo' })), 'feat-x · Opus · repo')
})

test('plan glyphs: 📋 closed/total, 📝 fresh, 🏁 all closed, 💬 declined, 📋? asked, nothing never asked', () => {
  assert.equal(plain(planText({ total: 5, open: 3, ageSec: 600 })!), '📋 2/5')
  assert.equal(plain(planText({ total: 5, open: 3 })!), '📋 2/5')
  assert.equal(plain(planText({ total: 5, open: 3, ageSec: 10 })!), '📝 2/5')
  assert.equal(plain(planText({ total: 5, open: 0, ageSec: 10 })!), '📝 5/5', 'a fresh change beats all-closed')
  assert.equal(plain(planText({ total: 5, open: 0, ageSec: 600 })!), '🏁 5/5')
  assert.equal(plain(planText({ total: 0, open: 0, asked: 'declined' })!), '💬')
  assert.equal(plain(planText({ total: 3, open: 1, asked: 'declined' })!), '📋 2/3', 'a later plan wins over declined')
  assert.equal(plain(planText({ total: 0, open: 0, asked: 'nagged' })!), '📋?')
  assert.equal(planText({ total: 0, open: 0 }), undefined)
  assert.equal(planText({ total: 3.5, open: 1 }), undefined, 'a number that is no count draws nothing')
})

test('planOf reads the record session-meta.ts writes; garbage draws nothing', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  assert.deepEqual(planOf({ plan_total: 5, plan_open: 3, plan_changed_at: '2026-11-26T11:59:30Z' }, now), { total: 5, open: 3, ageSec: 30 })
  assert.deepEqual(planOf({ plan_declined_at: '2026-11-26T11:00:00Z' }, now), { total: 0, open: 0, asked: 'declined' })
  assert.deepEqual(planOf({ plan_nagged_at: 'x' }, now), { total: 0, open: 0, asked: 'nagged' })
  assert.deepEqual(planOf({ plan_total: 2, plan_open: 1, plan_changed_at: 'garbage' }, now), { total: 2, open: 1 })
  assert.equal(planOf({ plan_total: '3 x' }, now), undefined)
  assert.equal(planOf(undefined, now), undefined)
})

test('the state glyph comes from display_state; an older record from its status, coarsely', () => {
  assert.equal(stateOf({ display_state: 'ready' }), 'ready')
  assert.equal(stateOf({ display_state: 'done_stale' }), 'done_stale')
  assert.equal(stateOf({ status: 'done' }), 'done')
  assert.equal(stateOf({ status: 'inprogress', ended_at: '2026-11-26T10:00:00Z' }), 'ended')
  assert.equal(stateOf({ status: 'inprogress' }), 'working')
  assert.equal(stateOf({ display_state: 'weird' }), 'unknown')
  assert.equal(stateOf({ display_state: 'toString' }), 'unknown', 'an inherited name is no state')
  assert.equal(stateOf(undefined), undefined, 'no record: no glyph')
  assert.equal(plain(lineText({ state: 'done_stale' })), '✅')
})

test('the account: the table names it, else the name after .claude-; a label off that name is yellow', () => {
  const table = { '.claude-home': 'home', '.claude-home2': 'home 🔑home2', '.claude': 'raw' }
  assert.deepEqual(accountOf('/Users/u/.claude-home', table), { label: 'home', foreign: false })
  assert.deepEqual(accountOf('/Users/u/.claude-home2/', table), { label: 'home 🔑home2', foreign: true })
  assert.deepEqual(accountOf('/Users/u/.claude', table), { label: 'raw', foreign: true })
  assert.deepEqual(accountOf('/Users/u/.claude-work', {}), { label: 'work', foreign: false })
  assert.equal(accountOf('/Users/u/.claude', {}), undefined)
  assert.equal(accountOf(undefined, table), undefined)
  assert.ok(lineText({ account: { label: 'work 🔑home', foreign: true } }).startsWith('\x1b[33m'), 'foreign: yellow')
  assert.ok(lineText({ account: { label: 'work', foreign: false } }).startsWith('\x1b[2m'), 'own: dim')
})

test('the total: two decimals and no leading zero; red past $50', () => {
  assert.equal(totalText(0.34), '$.34')
  assert.equal(totalText(7.05), '$7.05')
  assert.equal(totalText(0), '$.00')
  assert.ok(spendText({ totalUsd: 50.01 })!.startsWith('\x1b[31m'))
  assert.ok(spendText({ totalUsd: 49.99 })!.startsWith('\x1b[2m'))
})

test('Δ: the turn\'s input side and output side in one unit (moneyText)', () => {
  assert.equal(plain(spendText({ totalUsd: 0.34, turn: { inUsd: 0.1, outUsd: 0.4 } })!), '$.34Δ(10+40)¢')
  assert.equal(plain(spendText({ totalUsd: 3, turn: { inUsd: 1.24, outUsd: 0.45 } })!), '$3.00Δ$(1.24+.45)')
  assert.equal(plain(spendText({ totalUsd: 3 })!), '$3.00', 'no step answered yet this turn: no Δ')
})

test('≡ is lit against the real window: green under 30%, yellow to 60%, red past it', () => {
  const colour = (tokens: number, window: number) => /≡\x1b\[0m(\x1b\[\d+m)/.exec(spendText({ context: { tokens, window } })!)![1]
  assert.equal(colour(277_000, 1_000_000), '\x1b[32m', '277k of a 1M window is green, not the red of a 200k guess')
  assert.equal(colour(277_000, 200_000), '\x1b[31m')
  assert.equal(colour(300_000, 1_000_000), '\x1b[33m')
  assert.equal(colour(600_000, 1_000_000), '\x1b[33m')
  assert.equal(colour(600_001, 1_000_000), '\x1b[31m')
  assert.equal(plain(spendText({ context: { tokens: 277_400, window: 1_000_000 } })!), '≡277k')
  assert.equal(spendText({ context: { tokens: 1, window: 0 } }), undefined)
})

test('model ids read as names', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(modelName('claude-sonnet-5'), 'Sonnet 5')
  assert.equal(modelName('claude-opus-5-5[1m]'), 'Opus 5.5[1m]')
  assert.equal(modelName('us.anthropic.claude-fable-5-2'), 'Fable 5.2')
  assert.equal(modelName('gpt-x'), 'gpt-x')
})
