# Cold stop

<!-- gen:module src/cold-stop.ts -->
The cold stop: a prompt into a session whose cache has gone cold is more often sent by accident than on
purpose, and its turn re-sends the whole context. So the first such prompt is held before it reaches the
model, with what going on costs; anything sent within `coldStop.ackSec` of the stop goes through. Where the
plugin's mod loads, a slash command and `/compact` are held the same way. A background session is held too:
only a machine's prompt passes. Never held: a warm session, one with no turn yet, a turn that would cost less
than `coldStop.minUsd`, keeper's own commands and those in `coldStop.passCommands`, a peer's or a plugin's
message, a task notification, keeper's wake, a background job's launch prompt. A handoff brief's menu, when
one is ready, answers instead. Off by default: `coldStop.enabled` or `CTX_KEEPER_COLD_STOP=1`.

`coldStop.blockIf` (env `CTX_KEEPER_BLOCK_IF`): your shell command, asked first on every prompt a person may
have typed (never a machine's), warm or cold, for a stop only your tooling knows (the work went to another
session). It reads the facts as JSON on stdin (`session_id`, `transcript_path`, `prompt` up to 16,000
characters, `cold`, and `coldLines` when keeper would stop this prompt) and gets `CTX_KEEPER_SESSION_ID`,
`CTX_KEEPER_TRANSCRIPT_PATH`. Exit 2 stops the prompt with its stdout as the reason; put `coldLines` in it,
or keeper still owes its own stop. Exit 3 lets it through past keeper's stops (once the price was shown), its
stdout (if any) going to the model as context. Any other exit, a missing command or a timeout (3 s) leaves
the prompt to keeper.
<!-- /gen:module -->

The stop, on the first prompt into a cold cache:

```
cache-keeper: this session's prompt cache has gone cold (idle 1h 12m): this prompt was NOT sent.
Its turn would re-send ~151k tokens (≈ $1.51); a new session's first turn ≈ $0.40.
Go on here anyway: send it again within 15 min.
```

- Cold is the `cold` field `cache-keeper status --json` prints (src/warmth.ts): the handoff menu, the stop and
  outside tools never disagree on it. A session with nothing on record is `warm: false, cold: false`.
- A handoff brief that is ready answers with its menu instead, so one prompt meets one stop.
- A prompt the stop held never reached the model: it does not count as the person going on here
  (`personEnteredAt` stays where it was).

## Settings

Keys of the `coldStop` block in `config.json`:

<!-- gen:cold-stop-settings -->
| key | env | default | meaning |
|---|---|---|---|
| `enabled` | `CTX_KEEPER_COLD_STOP` | `false` | hold the first prompt into a cold session, with its price (see [Cold stop](cold-stop.md)) |
| `minUsd` | `CTX_KEEPER_COLD_STOP_MIN_USD` | `0.5` | a cold turn cheaper than this goes through unheld |
| `ackSec` | — | `900` | a prompt sent within this long of a stop goes through |
| `passCommands` | — | `["handoff", "session-end", "restart"]` | slash commands that go through a cold cache unheld, by name (a plugin's `ns:name` also by `name`); keeper's own always do |
| `blockIf` | `CTX_KEEPER_BLOCK_IF` | — | shell command asked on every prompt, cold or warm: exit 2 holds it with its stdout as the reason, exit 3 lets it through past the cold stop (see [Cold stop](cold-stop.md)) |
| `hint` | — | — | text added to the stop's last line, say how to hand off instead |
<!-- /gen:cold-stop-settings -->

Example: `"coldStop": { "enabled": true, "hint": "Hand off instead: /handoff [what next].", "blockIf": "my-handed-check" }`.
