/** The subagent decoration (hooks/agents.ts), as agents-statusline.ts drew it, now led into the row's label. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentLabel, agentText, humanTokens, shortAge, shortModel, statusMark } from '../hooks/agents.ts'

const NOW = Date.parse('2026-11-26T12:00:00Z')
const agent = (extra: Record<string, unknown> = {}) => ({ model: 'claude-opus-5', tokenCount: 105_077, contextWindowSize: 1_000_000, startTime: NOW - 12 * 60_000, taskStatus: 'running', ...extra })

test('model, context burnt, age', () => {
  assert.equal(agentText(agent(), NOW, 40), 'opus · 105k/1M · 12м')
})

test('an ended subagent is marked, a running one is not', () => {
  assert.equal(statusMark('running'), '')
  assert.equal(agentText(agent({ taskStatus: 'failed' }), NOW, 40), '❌ opus · 105k/1M · 12м')
  assert.equal(agentText(agent({ taskStatus: 'killed' }), NOW, 40), '⏹ opus · 105k/1M · 12м')
  assert.equal(agentText(agent({ taskStatus: 'completed' }), NOW, 40), '✓ opus · 105k/1M · 12м')
})

test('the tail is dropped first: the model matters most, the age least', () => {
  assert.equal(agentText(agent(), NOW, 18), 'opus · 105k/1M')
  assert.equal(agentText(agent(), NOW, 10), 'opus')
})

test('missing fields are left out, not printed as holes', () => {
  assert.equal(agentText({}, NOW, 40), '')
  assert.equal(agentText({ model: 'claude-sonnet-5' }, NOW, 40), 'sonnet')
  assert.equal(agentText({ tokenCount: 4200 }, NOW, 40), '4k')
})

test('the decoration leads the agent\'s own label; nothing to say keeps the label as it was', () => {
  assert.equal(agentLabel(agent(), 'reading files', NOW, 120), 'opus · 105k/1M · 12м · reading files')
  assert.equal(agentLabel({}, 'reading files', NOW, 120), 'reading files')
  assert.equal(agentLabel(agent(), '', NOW, 120), 'opus · 105k/1M · 12м')
})

test('model families, token counts, ages', () => {
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(shortModel('gpt-nonsense'), 'gpt-nonsense')
  assert.equal(humanTokens(999), '999')
  assert.equal(humanTokens(1000), '1k')
  assert.equal(humanTokens(1_500_000), '1.5M')
  assert.equal(humanTokens(12_000_000), '12M')
  assert.equal(shortAge(undefined, NOW), '')
  assert.equal(shortAge(NOW + 1000, NOW), '')
  assert.equal(shortAge(NOW - 30_000, NOW), 'сейчас')
  assert.equal(shortAge(NOW - 3 * 3_600_000, NOW), '3ч')
  assert.equal(shortAge(NOW - 50 * 3_600_000, NOW), '2д')
})
