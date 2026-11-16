# Status line

<!-- gen:module hooks/status.ts -->
The status line: one pinned line under the prompt saying whether keeper is on
and until when this session's prompt cache stays warm, counted from the last
model request. It refreshes on load, as each request goes out, a few seconds
after each turn and every 30 s. A session continued from another one starts at
`ready`. It also says when `node` on PATH cannot run the hooks, which would
otherwise fail without a word. Set `"statusLine": false` in config.json to turn
it off, e.g. when your own statusLine command already shows keeper. Where the
mod loads, band.ts draws the same line above the prompt with buttons, and this
line carries errors only (`"band": false` keeps it here).
<!-- /gen:module -->

Every form it takes, printed by the real `format()`:

<!-- gen:status-lines -->
- `ready`: keeper is on; nothing has been sent in this session yet.
- `cached till 14:05 · renews ×3`: the cache stays warm until 14:05, and keeper can extend it; 3 is how many pings it has left in this stretch. A ping still needs you back within `awaySec` and the away budget unspent: the line cannot see your keyboard, so away longer than that, 14:05 is final after all.
- `cached till 14:05`: no ping is coming (none left, the context is too small to hold, the session is muted, or a ping missed), so 14:05 is final.
- `cache expired`: the cache went cold; the next turn rewrites the whole context.
- `error: needs Node.js ≥ 22.18`: `node` on `PATH` is missing or too old to run the hooks, so keeper does nothing.
- `error: record failed · ~/.claude-cache-keeper/errors.log`: a hook of this session threw. Hooks still exit 0 (a session is never broken by keeper), but each failure is logged there, counted by `report`, shown by `/cache-keeper:status`, and, without mods, told once an hour on the session's next prompt. The line goes away once a turn is recorded cleanly.
- `(nothing)`: keeper is off, or `"statusLine": false`.
<!-- /gen:status-lines -->

## When a hook fails

<!-- gen:module src/errors.ts -->
A hook that fails never breaks your session; it leaves three traces instead: a line in
`$CACHE_KEEPER_HOME/errors.log` (rotated to errors.log.1 past 256 KB), an `error` event that `report` counts,
and `error: <hook> failed` on the status line until a turn is recorded cleanly again. Without the status line,
the session's next prompt gets one notice, at most once an hour.
<!-- /gen:module -->

## The band: the same line, clickable

<!-- gen:module hooks/band.ts -->
Where the mod loads, the status line moves above the prompt as a row of
buttons, `◉ 14:05 ↻3 ✓ ?`, and the status line keeps errors only:

- `◉ 14:05`: warm till 14:05 (`○ ready`, `○ cache expired` as above); `final`
  after it when no ping is coming.
- `↻3`: press to ping now, as `/cache-keeper:ping` does (a fork, no turn);
  3 pings are left. Dim while a turn runs.
- `✓`: press to stop keeping this session, as `/cache-keeper:done` does;
  `✓ done` once it is.
- `?`: press to pin the legend; hovering the row shows it too.

Without the mod there is no row and no line: the commands are the interface.
`"band": false` in config.json keeps the plain-text line instead.
<!-- /gen:module -->
