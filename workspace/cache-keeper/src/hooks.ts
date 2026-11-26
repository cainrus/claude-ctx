/** The hooks block shared by `hooks/hooks.json` and `cache-keeper install-snippet`. */

import { DEFAULT_DELAY_SEC } from './config.ts'

// INVARIANT: every hook enters through bin/cache-keeper.sh: without a usable node it exits 0 in silence (`check` says why).
export const LAUNCH = 'sh'

/** The plugin form: Claude Code substitutes the variable before the shell sees it. */
export const PLUGIN_SCRIPT = '"${CLAUDE_PLUGIN_ROOT}/bin/cache-keeper.sh"'

export const TOUCH_TIMEOUT_SEC = 60

export const WAIT_TIMEOUT_SEC = 7200

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function waitCommand(script: string): string {
  // WORKAROUND: under `claude -p` (sdk-cli) async hooks are not backgrounded, so the sleep would hold a one-shot run open.
  return (
    `[ "$CLAUDE_CODE_ENTRYPOINT" = sdk-cli ] || ` +
    `{ sleep "\${CACHE_KEEPER_DELAY_SEC:-${DEFAULT_DELAY_SEC}}"; ${LAUNCH} ${script} wake; }`
  )
}

interface CommandHook {
  type: 'command'
  command: string
  timeout: number
  asyncRewake?: boolean
}

export interface HooksBlock {
  hooks: Record<'SessionStart' | 'Stop' | 'UserPromptSubmit' | 'SessionEnd', Array<{ hooks: CommandHook[] }>>
}

export function buildHooks(script: string): HooksBlock {
  const run = (sub: string, timeout = 10): CommandHook => ({ type: 'command', command: `${LAUNCH} ${script} ${sub}`, timeout })
  return {
    hooks: {
      SessionStart: [{ hooks: [run('check')] }],
      Stop: [
        {
          hooks: [
            run('record'),
            { type: 'command', command: waitCommand(script), asyncRewake: true, timeout: WAIT_TIMEOUT_SEC },
          ],
        },
      ],
      UserPromptSubmit: [{ hooks: [run('touch', TOUCH_TIMEOUT_SEC)] }],
      SessionEnd: [{ hooks: [run('end')] }],
    },
  }
}
