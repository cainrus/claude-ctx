/**
 * Writes the plugin's hooks/hooks.json from the packages: the one hooks module
 * (hooks/ctx.ts) and each package's command hooks. `--check` writes nothing and
 * exits 1 when the file is stale.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildHooks, PLUGIN_SCRIPT } from '../workspace/cache-keeper/src/hooks.ts'

export const HOOKS_JSON = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url))

export function hooksJsonText(): string {
  return `${JSON.stringify({ modules: ['./ctx.ts'], ...buildHooks(PLUGIN_SCRIPT) }, null, 2)}\n`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = hooksJsonText()
  let have = ''
  try {
    have = readFileSync(HOOKS_JSON, 'utf8')
  } catch {
    // A missing file is stale.
  }
  if (process.argv.includes('--check')) {
    if (have !== want) {
      console.error('hooks/hooks.json is stale: run node scripts/hooks.ts')
      process.exit(1)
    }
  } else if (have !== want) {
    writeFileSync(HOOKS_JSON, want)
    console.log('hooks/hooks.json written')
  }
}
