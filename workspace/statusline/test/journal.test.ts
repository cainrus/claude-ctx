/**
 * The files other tools read, written through bin/statusline.ts exactly as the
 * mod calls it: the rate-limit journal (the dashboard fits "% of the limit per
 * $" from it, so a missed step or a duplicate both matter) and the AI Usage
 * Barometer feed. Both formats are statusline.sh's, byte for byte.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeWindow, windowOf } from '../src/rates.ts'

const CLI = fileURLToPath(new URL('../bin/statusline.ts', import.meta.url))
const SID = '55555555-6666-7777-8888-999999999999'
const RESET5 = '2026-11-26T22:00:00.000Z'
const RESET7 = '2026-12-02T08:00:00.000Z'

function cli(cmd: string, input: unknown) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, cmd], { input: JSON.stringify(input), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '', 'nothing printed')
  return r
}

function sandbox(t: { after: (fn: () => void) => void }, account = '.claude-work2') {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-rl-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'rl')
  const measure = (five: number | null, week: number | null, reset5 = RESET5) => {
    const limits = [
      ...(five === null ? [] : [{ kind: 'five_hour', percentUsed: five, resetsAt: reset5 }]),
      ...(week === null ? [] : [{ kind: 'seven_day', percentUsed: week, resetsAt: RESET7 }]),
    ]
    cli('rate', { dir, account, session: SID, at: Math.floor(Date.now() / 1000), limits })
  }
  const journal = join(dir, `${account}.jsonl`)
  const lines = () => (existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  return { root, dir, measure, lines, journal }
}

test('one line per step of the pair, none for a repeated reading', (t) => {
  const { measure, lines } = sandbox(t)
  measure(27, 26)
  measure(27, 26)
  measure(28.000000000000004, 26)
  const got = lines()
  assert.deepEqual(got.map((l) => [l.five, l.week]), [[27, 26], [28, 26]])
  assert.equal(got[0].five_reset, Date.parse(RESET5) / 1000)
  assert.equal(got[0].week_reset, Date.parse(RESET7) / 1000)
  assert.equal(got[0].session, SID)
  assert.ok(Math.abs(got[0].at - Date.now() / 1000) < 30)
  assert.deepEqual(Object.keys(got[0]), ['at', 'session', 'five', 'five_reset', 'week', 'week_reset'], 'the field order the readers were written against')
})

test('a stale reading from another session of the account writes nothing', (t) => {
  const { measure, lines } = sandbox(t)
  measure(2, 27)
  measure(1, 26)
  measure(2, 27)
  assert.deepEqual(lines().map((l) => [l.five, l.week]), [[2, 27]])
})

test('a new 5-hour window is a step even though the value dropped', (t) => {
  const { measure, lines } = sandbox(t)
  measure(80, 30)
  measure(3, 30, '2026-11-27T03:00:00.000Z')
  measure(70, 30)
  assert.deepEqual(lines().map((l) => [l.five, l.week]), [[80, 30], [3, 30]])
})

test('the journal is named by the config dir, so accounts never mix; a missing window is null', (t) => {
  const { measure, lines, dir } = sandbox(t, '.claude-home')
  measure(41, null)
  assert.deepEqual(lines().map((l) => [l.five, l.week, l.week_reset]), [[41, null, null]])
  assert.equal(readFileSync(join(dir, '.claude-home.last'), 'utf8'), `41|${Date.parse(RESET5) / 1000}||\n`)
})

test('no reading at all, or an account that is a path: nothing written', (t) => {
  const { dir, lines, root } = sandbox(t)
  cli('rate', { dir, account: '.claude-work2', session: SID, limits: [] })
  cli('rate', { dir, account: '../escape', session: SID, limits: [{ kind: 'five_hour', percentUsed: 5 }] })
  assert.deepEqual(lines(), [])
  assert.equal(existsSync(join(root, 'escape.jsonl')), false)
})

test('the engine\'s reading as the journal keeps it: whole percent, epoch seconds', () => {
  assert.deepEqual(windowOf({ percentUsed: 23.5, resetsAt: RESET5 }), { pct: 24, reset: Date.parse(RESET5) / 1000 })
  assert.deepEqual(windowOf({ percentUsed: 7 }), { pct: 7, reset: null })
  assert.deepEqual(windowOf(undefined), { pct: null, reset: null })
  assert.deepEqual(mergeWindow({ pct: 5, reset: null }, { pct: 3, reset: 100 }), { window: { pct: 5, reset: 100 }, moved: true })
})

test('the barometer feed: schema 2, written whole, private', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-baro-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'ai-usage-barometer', 'claude-statusline.json')
  cli('barometer', { file, at: 1795725612, session: SID, version: '2.1.332', limits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: RESET5 }] })
  const j = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(j, {
    schema_version: 2,
    source: 'claude-code-statusline',
    captured_at: 1795725612,
    session_id: SID,
    claude_code_version: '2.1.332',
    five_hour_present: true,
    seven_day_present: false,
    five_hour: { used_percentage: 41, resets_at: Date.parse(RESET5) / 1000 },
    seven_day: null,
  })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(root, 'ai-usage-barometer')).mode & 0o777, 0o700)
})

test('bad input is exit 0 and silence', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'rate'], { input: '{not json', encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout + r.stderr, '')
  cli('nonsense', {})
})
