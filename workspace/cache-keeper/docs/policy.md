# How it decides

<!-- gen:module src/policy.ts -->
Decides whether an idle session gets a ping now. The first matching row refuses it and names the ledger reason:
`done` (you ran /ctx:done), `away` (idle past `awaySec`), `away-budget-spent` (not at the keyboard and
the machine-wide `maxAwayPings` spent), `context-too-small` (below `minCtxTokens`), `cache-expired` (older than
`maxAgeSec`), `cache-still-warm` (younger than `minAgeSec`), `budget-spent` (`maxPings` used this idle stretch),
`oracle-miss` (the previous ping missed the cache). Tune each row with its config key; `enabled: false` stops all.
<!-- /gen:module -->

## Presence

<!-- gen:module src/presence.ts -->
Reads how long the keyboard and mouse have been idle, before each ping. macOS: `HIDIdleTime`, which keeps
counting through a closed lid or a locked screen. Linux: the first that answers of GNOME's Mutter idle monitor,
the freedesktop ScreenSaver interface (KDE), `xprintidle` (X11), then logind's idle hint (only with a graphical
session). Elsewhere, or when no probe answers, presence is unknown: the `away` row lets the ping through, but the
away budget counts it as not at the keyboard. `CACHE_KEEPER_IDLE_SEC` overrides the probe (seconds or `unknown`);
`CACHE_KEEPER_BACKGROUND=0|1` forces a session to count as interactive or background.
<!-- /gen:module -->

## skipIf

<!-- gen:module src/veto.ts -->
`skipIf` (env `CACHE_KEEPER_SKIP_IF`): your shell command, run through `/bin/sh` before a ping or a due handoff
that passed every other row, for what only your tooling knows: the task is finished, handed off, a batch job.
It gets `CACHE_KEEPER_SESSION_ID`, `CACHE_KEEPER_TRANSCRIPT_PATH` and `CACHE_KEEPER_LAST_PROMPT_AT` (ISO).
Exit 0 skips the ping. Exit 3 means someone else holds the session and would rather continue in a new one:
no ping, and a handoff when one is due. Any other exit, a missing command or a timeout (5 s) lets the ping out.
Unset it to turn the veto off.
<!-- /gen:module -->

## The cap tunes itself

<!-- gen:module src/tune.ts -->
Moves `maxPings`, the pings per idle stretch, by the ledger, unless you set `maxPings` yourself. The k-th ping
is worth sending while you come back warm right after it more often than breakeven (wake cost / rewrite avoided,
both measured from the ledger). Once a day, with at least 30 pings at the cap's position in the last 60 days,
the cap goes up a step when that position kept 2× breakeven warm and down a step below breakeven, within [2, 8].
The decision is kept in `$CACHE_KEEPER_HOME/tuning.json`; `cache-keeper report` prints the cap and why.
<!-- /gen:module -->

## Commands

- `/ctx:done`: you will not come back to this session; no more pings or handoff until your next message
  there. Answered by the hook, so it costs no model request.
- `/ctx:ping`: renew the cache now, outside keeper's budgets (a [fork](fork-pings.md) where the mod loads).
- `/ctx:status`:

<!-- gen:module src/inspect.ts -->
`/ctx:status` shows what keeper knows of this session (cached till when, pings used of the cap, context
size, whether pings go as forks, a missed ping, a mute by /ctx:done, the last hook error, a compaction)
and every setting in force with where it came from: `env`, `config.json`, `tuned` (the cap) or `default`.
It warns about settings that leave keeper unable to ping at all. The hook answers it: no model request is made.
<!-- /gen:module -->
