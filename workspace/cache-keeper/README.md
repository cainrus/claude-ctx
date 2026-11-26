# cache-keeper

A package of the [claude-ctx](../../README.md) plugin (formerly `cainrus/claude-cache-keeper`).

Keeps the prompt cache of an idle [Claude Code](https://docs.claude.com/en/docs/claude-code) session warm, but only
while someone is plausibly coming back to it. Claude Code caches the conversation for one hour; an hour of idling
makes the next turn rewrite the whole context (about $2 for a 200k-token Opus session) where a cheap read would have
kept it alive. The keeper pings the cache before it expires and decides, from your keyboard presence, a per-session
budget and its own ledger, when that ping is worth it. Pure Claude Code hooks: no proxy, no MCP server, no daemon,
no dependencies; TypeScript run directly by Node ≥ 22.18.

```sh
claude plugin marketplace add cainrus/claude-ctx
claude plugin install ctx@claude-ctx
```

State, ledger and `config.json` live in `~/.claude-ctx/keeper` (`CTX_KEEPER_HOME`); every setting is a
`CTX_KEEPER_*` variable. The commands are `/ctx:done`, `/ctx:status` and `/ctx:ping`.

## Docs

Each page is short and stands alone; open the one the question is about.

- [How it works](docs/how-it-works.md): the problem, the hook chain, why hooks and not a proxy
- [How it decides](docs/policy.md): the policy rows, presence, budgets, the self-tuning cap, `/ctx:done`, `:status`, `:ping`
- [Install](docs/install.md): Node requirement, plugin and non-plugin install
- [Configuration](docs/config.md): every setting, its env variable and default (generated from the code)
- [Status line](docs/status-line.md): every form of the line under the prompt (generated)
- [Fork pings](docs/fork-pings.md): pinging with `$.model.fork` instead of a turn, compaction, waiting questions
- [Handoff](docs/handoff.md): a brief before the cache dies and a menu when you come back cold
- [Cold stop](docs/cold-stop.md): the first prompt into a cold session held with its price; `blockIf` for stops of your own; `status --json`
- [Report](docs/report.md): the ledger, its events (generated) and `cache-keeper report`
- [Results on one machine](docs/results.md): the author's ledger over 33 days
- [Limitations](docs/limitations.md)
- [Development](docs/development.md): tests, fixtures, regenerating the docs
- [Design](docs/DESIGN.md): the full rationale

## License

[Apache-2.0](../../LICENSE) © 2026 Sergei Tarassov
