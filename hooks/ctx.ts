/**
 * The plugin's one hooks module: Claude Code loads one module per plugin, so this
 * one registers every package's hooks in workspace/. Each package owns its events;
 * a package turns itself off from its own config, never from here.
 */

import type { Register } from 'claude-code'
// WORKAROUND: Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and
// reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
// @ts-ignore TS5097
import { register as registerCacheKeeper } from '../workspace/cache-keeper/hooks/gate.ts'

export const register: Register = (on, options) => {
  registerCacheKeeper(on, options)
}
