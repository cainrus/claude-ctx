/**
 * The root plugin: its manifests agree with package.json, and hooks/hooks.json
 * is what scripts/hooks.ts builds from the packages.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOKS_JSON, hooksJsonText } from '../scripts/hooks.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

test('manifests agree with package.json', () => {
  const pkg = json('package.json')
  const plugin = json('.claude-plugin/plugin.json')
  const market = json('.claude-plugin/marketplace.json')
  assert.equal(plugin.name, 'ctx')
  assert.equal(plugin.version, pkg.version)
  assert.equal(market.name, 'claude-ctx')
  assert.equal(market.plugins[0].name, plugin.name)
  assert.equal(market.plugins[0].version, pkg.version)
  assert.equal(market.plugins[0].source, './')
})

test('hooks/hooks.json is what scripts/hooks.ts builds (run it after a change)', () => {
  assert.equal(readFileSync(HOOKS_JSON, 'utf8'), hooksJsonText())
  assert.deepEqual(json('hooks/hooks.json').modules, ['./ctx.ts'])
})

test('every command hook enters a package through its launcher under the plugin root', () => {
  const { hooks } = json('hooks/hooks.json') as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  for (const groups of Object.values(hooks)) {
    for (const g of groups) for (const h of g.hooks) assert.match(h.command, /"\$\{CLAUDE_PLUGIN_ROOT\}\/workspace\/[a-z-]+\/bin\//)
  }
})
