# Results on one machine

The author's own ledger, 2026-09-25 to 2026-10-28 (33 days): two Claude Code profiles on one Mac, mostly Opus,
interactive and background sessions.

```
pings
  sent                        1245
  cache hits                  1191
  cache misses                   3
  not scored                    51

idle stretches with a ping
  resumed                      459
    while still warm           359
    paid turn measured           0
    held, not used               0
  abandoned                    182

estimate at API list prices
  rewrites avoided         $998.33
  ping cost                $180.18
  balance                 +$818.15
```

3 misses out of 1194 scored pings: a ping almost never arrives to find the cache already gone. The 182 stretches
that were pinged and never resumed are counted in the ping cost. The saving is an estimate: each stretch resumed
while warm is valued as a full 1h rewrite of its context. Measured savings (see [Report](report.md)) start with 0.4.0,
so this ledger has none yet. On a subscription the balance is usage-limit headroom, not money.
