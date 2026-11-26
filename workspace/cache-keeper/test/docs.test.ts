import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GENERATORS, render, staleDocs } from '../scripts/docs.ts'
import { loadConfig, SETTINGS } from '../src/config.ts'
import { settingsOf } from '../src/inspect.ts'

const NO_HOME = { CACHE_KEEPER_HOME: join(tmpdir(), 'cache-keeper-docs-test-no-home') }

test('the docs match the code: run `node scripts/docs.ts` after changing SETTINGS, STATUS_EXAMPLES or LEDGER_EVENTS', () => {
  assert.deepEqual(staleDocs(), [])
})

test('every setting /cache-keeper:status reports is documented, and every documented key exists', () => {
  const reported = settingsOf(loadConfig(NO_HOME), NO_HOME).map((s) => s.key)
  const documented = SETTINGS.flatMap((s) => (s.key === undefined ? [] : [s.key]))
  // env-only settings status still names by their Config field
  const envOnly: Record<string, string> = { delaySec: 'CACHE_KEEPER_DELAY_SEC' }
  for (const key of reported) {
    const covered = documented.includes(key) || SETTINGS.some((s) => s.key === undefined && s.env === envOnly[key])
    assert.ok(covered, `${key} is reported but not in SETTINGS`)
  }
  // keys loadConfig reads but settingsOf does not list
  const notReported = new Set(['prices', 'handoff.closeCommand'])
  for (const key of documented) assert.ok(reported.includes(key) || notReported.has(key), `${key} is in SETTINGS but keeper never reads it`)
})

test('every documented env variable really drives the key it is documented for', () => {
  // a value each parser accepts and that differs from every default
  const sample = (key: string): string => (['enabled', 'forkPings', 'handoff.enabled', 'handoff.closeAfterSpawn'].includes(key) ? '0' : key === 'hitRatio' ? '0.5' : key.endsWith('Command') || key === 'skipIf' ? 'true' : '7')
  for (const s of SETTINGS) {
    if (s.key === undefined || s.env === undefined) continue
    const name = s.env.replace(/=.*$/, '')
    const env = { ...NO_HOME, [name]: s.env.endsWith('=1') ? '1' : sample(s.key) }
    const row = settingsOf(loadConfig(env), env).find((r) => r.key === s.key)
    assert.equal(row?.source, 'env', `${name} does not set ${s.key}`)
  }
})

test('an unknown generated block is an error, not silently left alone', () => {
  assert.throws(() => render('<!-- gen:nope -->\n<!-- /gen:nope -->'), /unknown generated block "nope"/)
  assert.ok(Object.keys(GENERATORS).length >= 4)
})
