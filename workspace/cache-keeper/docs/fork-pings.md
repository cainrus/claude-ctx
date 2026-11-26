# Fork pings

<!-- gen:module src/fork.ts -->
Fork pings: where the plugin's mod loads, keeper pings with a fork of the main thread instead of a wake turn.
A fork re-sends the last request with one short question, so the cache is read and renewed while nothing
is added to the transcript. The policy, budgets and report are the same as for wake turns. A fork that
fails is sent again, then falls back to a wake turn while the cache can still be reached warm. Forks also
hold the cache while a question (AskUserQuestion) waits for your answer, and `/ctx:ping` uses one.
Without the mod (an older Claude Code, mods off) pings are wake turns as before.
Off: `"forkPings": false` or `CTX_KEEPER_FORK=0`.
<!-- /gen:module -->

After a compaction nothing of the new context is cached until a turn sends it, so keeper sends no ping until the
next turn (ledger reason `compacted`). Why a fork alone may not carry the cache through a compaction, and the other
edge cases: [Guardrails](guardrails.md).
