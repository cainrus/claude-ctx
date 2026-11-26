/**
 * The plugin's one hooks module: Claude Code loads one module per plugin and
 * takes one hook per event from it, so this one registers every package's hooks
 * in workspace/. Each package registers the events only it hooks; the events
 * two of them need are registered here, once, and call each package's part.
 */

import type { Register } from 'claude-code'
// WORKAROUND: Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and
// reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
// @ts-ignore TS5097
import { keeperTurnStarted, keeperTurnStep, registerKeeperOwn } from '../workspace/cache-keeper/hooks/gate.ts'
// @ts-ignore TS5097
import { registerStatusline, statuslineStepAnswered, statuslineTurnStarted } from '../workspace/statusline/hooks/statusline.ts'

export const register: Register = on => {
  registerKeeperOwn(on)
  registerStatusline(on)

  on('turn.start', ($, e, next) => {
    keeperTurnStarted(e)
    statuslineTurnStarted($, e)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* keeperTurnStep($, e, next)
    statuslineStepAnswered($, e, step?.usage)
    return step
  })
}
