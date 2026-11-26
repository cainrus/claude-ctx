# Status line

<!-- gen:module hooks/status.ts -->
The status line: one pinned line under the prompt saying whether keeper is on
and until when this session's prompt cache stays warm, counted from the start
of the last model request, in the bucket it really wrote. It refreshes as each
request goes out, after each turn and every 30 s; a resumed session shows `ready`
until its next request. Once cold, it says what the next turn costs
and, when cheaper, a new session's first turn; it also says when `node` on PATH
cannot run the hooks. Set `"statusLine": false` in config.json to turn it off.
Where the mod loads, band.ts draws the line above the prompt and this one
carries errors only (`"band": false` keeps it here).
<!-- /gen:module -->

Every form it takes, printed by the real `format()`:

<!-- gen:status-lines -->
- `○ ready`: keeper is on; no request seen in this session yet (a resumed session too).
- `◉ 14:05→~16:35  $0.17+$0.05+$0.15`: the cache stays warm until 14:05 for sure, and keeper can extend it: if every ping left in this stretch (3 here) goes out, it holds until about 16:35. That end is the earliest one: a ping goes out once the cache is `minAgeSec` old (50 min) and renews it from then. The money: $0.17 this session's pings cost so far, $0.05 the next turn's prompt read from this cache, $0.15 the pings left (each a read of the context). A ping still needs you back within `awaySec` and the away budget unspent: the line cannot see your keyboard, so away longer than that, 14:05 is final after all.
- `◉ 14:05  $0.17+$0.05`: no ping is coming (none left, the context is too small to hold, the session is muted, a ping missed, or the first ping would land after the cache went cold), so 14:05 is final. The band still offers `↻` while the cache is warm, a ping is left and the session is not muted: a ping you press goes out even when none would on its own.
- `○ cold · next $0.98`: the cache went cold; the next turn writes the whole context anew, at $0.98. Switching model costs nothing extra now.
- `○ cold · next $0.98 ⇄$0.30`: the same, and a new session would pay $0.30 for its first turn (its start prompt, written anew): the floor of a handoff, shown only when it is cheaper.
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
buttons, `◉ 14:05→~16:35 ↻3 $0.17+$0.05+$0.15 ✓ ?`, and the status line keeps
errors only:

- `◉ 14:05→~16:35` and the money after it: as on the status line above;
  `final` in place of the button when no ping is left or the session is muted. The time turns yellow in
  the last 10 minutes (half the TTL on a 5-minute cache); the cold line is green:
  switching model costs nothing extra now. The status line has no colour.
- `↻3`: press to ping now, as `/cache-keeper:ping` does (a fork, no turn);
  3 pings are left. Dim while a turn runs.
- `✓`: press to stop keeping this session, as `/cache-keeper:done` does;
  `✓ done` once it is.
- `?`: press to pin the legend; hovering the row shows it too.

Without the mod there is no row and no line: the commands are the interface.
`"band": false` in config.json keeps the plain-text line instead.
<!-- /gen:module -->
