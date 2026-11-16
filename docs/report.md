# Report

<!-- gen:module src/report.ts -->
`cache-keeper report` (or `--json`) sums up the ledger: pings sent, cache hits and misses, idle stretches resumed
warm or abandoned, refusals by reason, hook errors, and the money: rewrites avoided minus ping cost.
A resumed stretch is worth a full rewrite of its context minus what its first request really paid; without that
measurement it is estimated from the context size. Money is at API list prices, set per model with `prices` in
config.json; on a subscription the same tokens count against usage limits, so the balance still matters.
<!-- /gen:module -->

```
$ node bin/cache-keeper.ts report        # synthetic ledger
pings
  sent                          10
  cache hits                     9
  cache misses                   1
idle stretches with a ping
  resumed                        6
    while still warm             6
  abandoned                      4
refusals                        38
  away                          21
  context-too-small              7
at API list prices (measured where paid, estimated elsewhere)
  rewrites avoided           $8.98
  ping cost                  $1.50
  balance                   +$7.47
```

## Ledger events

Every decision is one line in `$CACHE_KEEPER_HOME/ledger.jsonl`:

<!-- gen:ledger-events -->
| event | one line means |
|---|---|
| `ping` | a ping went out; `pings` is its place in the idle stretch, `transport: "fork"` when it was a fork |
| `skip` | no ping; `reason` names the policy row that refused it (see [How it decides](policy.md)) |
| `resume` | a real prompt ended an idle stretch that had pings; `pings` spent, `lastPingHit`; `detail: "question"` for an answer to a waiting question |
| `resume-paid` | what the first request of that resumed turn really paid (`cacheRead`, `cacheWrite`) |
| `wake-hit` | a ping read the cache; its usage is the cost line; `detail: "handoff"` for a brief turn |
| `wake-miss` | a ping found the cache gone and wrote it again; mutes the session |
| `handoff-request` | instead of letting the cache go, the brief turn was sent |
| `handoff-ready` | the brief is on disk |
| `handoff-here` | the menu was answered with continue here (`detail: "unattended"` in a background session) |
| `handoff-new` | the menu was answered with a new session, and `spawnCommand` started it |
| `handoff-failed` | no brief, or the new session did not start; `failure` says which step |
| `done` | `/cache-keeper:done`: no pings until the next real prompt |
| `fork-failed` | a fork brought no reply; `failure` is its reason, `next` what follows (`retry`, `turn`, `drop`) |
| `renew` | a compaction after an hour held by forks alone was put off behind one wake turn |
| `manual-ping` | `/cache-keeper:ping`; not scored, its cost is in the ping cost |
| `error` | a hook threw (errors.ts); `detail` is `<hook>: <message>` |
<!-- /gen:ledger-events -->
