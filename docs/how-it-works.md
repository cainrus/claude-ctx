# How it works

Claude Code caches the conversation prefix for **one hour** on a subscription. A cache write costs **2×** the base
input price, a read **0.1×**, and a read renews the hour. Idle 61 minutes, and the next turn rewrites the whole
context: about **$2.00** for a 200k-token Opus session, against about **$0.10** for a read that would have kept it.
The read is easy; deciding when it is worth it is the work, because most idle stretches are never resumed.

```
Stop ──► record      remember when the cache was last touched and how big it is
     └─► sleep; wake decide: exit 0 = let it go, exit 2 = ping (the model replies "ok")
UserPromptSubmit ──► touch   a real prompt closes the idle stretch
SessionEnd       ──► end     forget the session
turn.complete (mod) ──► arm  where the plugin's mod loads: ping by fork instead
```

A ping that reads the cache is a *hit*; one that had to rewrite it is a *miss* and mutes that session for good.

| design | failure mode | verdict |
|---|---|---|
| local proxy replaying the last request | the proxy is the API endpoint: if it dies, every session dies | rejected |
| plugin monitor | starts only in interactive sessions, not `--bg` | rejected |
| **`Stop` hook with `asyncRewake`** | the hook dies → no ping, the session is unaffected | **chosen** |

Decisions: [How it decides](policy.md). The full rationale: [DESIGN.md](DESIGN.md); the code's own why: [Guardrails](guardrails.md).
