# statusline

A package of the [claude-ctx](../../README.md) plugin: the line under the prompt, drawn by the plugin's mod from the
engine's own figures, with no `statusLine` command and no process per keystroke.

```
cc:81ef4c9f home 🔑home2 ⏳ 📋 2/4 · main±2↑1 · Opus 5.5 · claude-ctx · $7.05Δ(10+40)¢ ≡277k
```

- `cc:<id8>`: the session; a link where `CTX_STATUSLINE_SESSION_URL` is set.
- the account: the config dir's name after `.claude-`, or the label `CTX_STATUSLINE_ACCOUNTS` gives it; yellow when
  the label is not that name (another account's key in this profile).
- the state glyph and the plan (`📋 2/4`, `📝` just changed, `🏁` all closed, `💬` declined, `📋?` asked): from a
  session record in `CTX_STATUSLINE_META_DIR`, when there is one.
- the branch of the folder being worked on, with `±` changed files (untracked too) and `↑` commits ahead of its
  upstream. The folder is the newest checkout of the same project the session's recent tool calls touched, so work in
  a sibling worktree shows that worktree's branch. A branch that repeats the folder's name is left out.
- the model, the folder.
- the spend: the session's total (red past $50), `Δ` this turn's prompt side (fresh input, cache reads and writes)
  and output side, a subagent's requests included, and `≡` the context, green under 30% of the model's real window,
  yellow to 60%, red past it. The total is the engine's estimate, as `/cost` counts it; `Δ` is priced from list
  prices (cache-keeper's `src/prices.ts`).

Each subagent's row in the agent panel leads its words with `opus · 105k/1M · 12м`: its model, its context against
its window, how long it has run, and `✓`/`❌`/`⏹` once it ended.

On every `session.measure` that moves the account's limits (background sessions too), it can also write:

- the rate-limit journal, `<dir>/<config dir name>.jsonl` and `.last`, one line per whole-point step of the 5-hour
  and weekly usage (`CTX_STATUSLINE_RATE_DIR`);
- the AI Usage Barometer feed, a schema-2 JSON file the SwiftBar plugin reads (`CTX_STATUSLINE_BAROMETER`).

Both formats are the ones `statusline.sh` wrote, so their readers did not change.

## Settings

Every setting is an environment variable (a settings file's `env` block works):

| env | meaning |
|---|---|
| `CTX_STATUSLINE_DISABLED` | `1`: no line and no agent decoration from this mod; the engine draws its own (a `statusLine` command, or nothing) |
| `CTX_STATUSLINE_SESSION_URL` | link `cc:<id8>` to this URL, `{id}` and `{id8}` filled in; the plan glyph links to it with `#plan` |
| `CTX_STATUSLINE_ACCOUNTS` | JSON object, config-dir name to account label (`{".claude-work2": "work 🔑work2"}`); a label other than the name after `.claude-` shows yellow |
| `CTX_STATUSLINE_META_DIR` | folder of session records `<session id>.json` (`display_state`, `plan_total`, `plan_open`, ...), relative to `CLAUDE_CONFIG_DIR`; unset, no state glyph and no plan |
| `CTX_STATUSLINE_BRANCH_DIR` | folder of files `<session id>` naming the branch the session works on, shown over the checked-out one; relative to `CLAUDE_CONFIG_DIR` |
| `CTX_STATUSLINE_IGNORE` | `:`-separated path prefixes that never pick the folder being worked on (`~/.claude` always does not) |
| `CTX_STATUSLINE_RATE_DIR` | journal each whole-point step of the 5-hour and weekly limits to `<dir>/<config-dir name>.jsonl` (`RATE_LIMITS_DIR` is read too) |
| `CTX_STATUSLINE_BAROMETER` | write the limits to this file for the AI Usage Barometer SwiftBar plugin (`AI_USAGE_CLAUDE_STATUS_CACHE` is read too) |
| `CTX_STATUSLINE_CACHE_DIR` | where the git counts every session shares live; default `~/.cache/claude-statusline` (`STATUSLINE_CACHE_DIR` is read too) |

A `statusLine` command of your own keeps its output; the line goes on the row below it.

## How it stays cheap

Drawing reads only what is in memory. The facts are refreshed by the engine's events (`session.measure`, each
request's answer, each turn's start) and a ten-second tick that reads a few files. git runs only in
`bin/statusline.ts git`, in the background, one process per checkout for every session of every profile under a
lock, tracked files every 20 s (at once when the index or HEAD moves) and untracked ones every two minutes.

## Layout

- `hooks/line.ts`: the line from its facts, pure.
- `hooks/agents.ts`: the agent rows' decoration, pure.
- `hooks/gitfacts.ts`: the branch, the counts file and the worked-on folder, from files git keeps.
- `hooks/statusline.ts`: the mod side; `registerStatusline` and the two calls cache-keeper's `turn.start` and
  `turn.step` make (one hook per event per plugin: the root `hooks/ctx.ts` wires them).
- `bin/statusline.ts`, `src/`: what a mod cannot do (append, rename, run git under a lock).
