# Configuration

Environment variables (set them in the `env` block of your Claude Code settings so hooks inherit them) override
`$CTX_KEEPER_HOME/config.json`, which overrides the defaults. The JSON keys are the names in the first column.
`/ctx:status` shows every value in force and where it came from.

The table is generated from `SETTINGS` in `src/config.ts` (`node scripts/docs.ts`); edit it there.

<!-- gen:settings -->
| key | env | default | meaning |
|---|---|---|---|
| — | `CTX_KEEPER_DELAY_SEC` | `3000` | how long the waiter sleeps after each turn; keep it between `minAgeSec` and `maxAgeSec` (env only: the shell reads it) |
| — | `CTX_KEEPER_HOME` | `~/.claude-ctx/keeper` | state, ledger and `config.json` |
| `enabled` | `CTX_KEEPER_DISABLED=1` | `true` | master switch |
| `awaySec` | `CTX_KEEPER_AWAY_SEC` | `1200` | idle longer than this = gone |
| `presenceSec` | `CTX_KEEPER_PRESENCE_SEC` | `300` | idle up to this = at the keyboard |
| `maxAwayPings` | `CTX_KEEPER_MAX_AWAY_PINGS` | `6` | machine-wide pings per absence |
| `minCtxTokens` | `CTX_KEEPER_MIN_CTX_TOKENS` | `20000` | smallest context worth holding |
| `minAgeSec` | `CTX_KEEPER_MIN_AGE_SEC` | `3000` | earliest ping |
| `maxAgeSec` | `CTX_KEEPER_MAX_AGE_SEC` | `3480` | latest ping |
| `maxPings` | `CTX_KEEPER_MAX_PINGS` | auto, from `4` | pings per idle stretch; unset, it is [tuned](policy.md#the-cap-tunes-itself) from this start, set, the tuning is off |
| `hitRatio` | `CTX_KEEPER_HIT_RATIO` | `0.9` | wake turn counts as a hit at `read / (read + write) ≥` this; a value above 1 is ignored |
| `prices` | — | per model, `src/prices.ts` | USD per million tokens, for `report` and the handoff menu: `{"claude-opus-5-5": {"input": 4, "cacheRead": 0.2, "cacheWrite": 8, "output": 20}}` per model id prefix, or a number for a family (`"opus": 5`: input, with 0.1× read, 2× write, 5× output). No Anthropic API serves prices, so the table is kept by hand; `report` names any model it has no row for |
| `skipIf` | `CTX_KEEPER_SKIP_IF` | — | shell command asked before each ping or due handoff; exit 0 skips, exit 3 hands off (see [How it decides](policy.md)) |
| — | `CTX_KEEPER_IDLE_SEC` | — | override the presence probe (a number of seconds, or `unknown`) |
| — | `CTX_KEEPER_BACKGROUND` | — | `0`/`1`: treat the session as interactive / background regardless of `CLAUDE_JOB_DIR` and the transcript |
| `statusLine` | — | `true` | show the cache line under the prompt (see [Status line](status-line.md)); only `false` turns it off |
| `band` | — | `true` | draw that line above the prompt with buttons instead, where the mod loads (see [The band](status-line.md#the-band-the-same-line-clickable)); `false` keeps it plain text |
| `forkPings` | `CTX_KEEPER_FORK` | `true` | ping with a fork instead of a wake turn where the plugin's mod loads (see [Fork pings](fork-pings.md)) |
| `cacheTtlSec` | — | `3600` | the cache TTL `/ctx:status`, `/ctx:ping`, the report and the ping timing assume; the status line uses the bucket the last turn really wrote and falls back to this; change it only if yours is not one hour |
| `handoff.*` | | | see [Handoff](handoff.md) |
<!-- /gen:settings -->

The defaults assume the 1-hour TTL of a subscription. On an API key the TTL is 5 minutes unless configured
otherwise; the first ping will then miss and the oracle will mute the session, which is safe but useless.
