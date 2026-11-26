# claude-ctx

[![CI](https://github.com/cainrus/claude-ctx/actions/workflows/ci.yml/badge.svg)](https://github.com/cainrus/claude-ctx/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

One [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin, `ctx`, for what a session's context costs and
how long it stays warm. It is assembled from the packages in [`workspace/`](workspace); each has its own README,
settings and docs. Pure Claude Code hooks and one mod: no proxy, no MCP server, no daemon, no dependencies;
TypeScript run directly by Node ≥ 22.18.

```sh
claude plugin marketplace add cainrus/claude-ctx
claude plugin install ctx@claude-ctx
```

## Packages

- [cache-keeper](workspace/cache-keeper/README.md): keeps an idle session's prompt cache warm, but only while someone
  is plausibly coming back to it; `/ctx:done`, `/ctx:status`, `/ctx:ping`. Formerly
  [cainrus/claude-cache-keeper](https://github.com/cainrus/claude-cache-keeper).

## Development

```sh
npm test                 # every package's tests and the root's
node scripts/hooks.ts    # rebuild hooks/hooks.json after a package changes its command hooks
```

The plugin installs from git without `npm install`, so the root module (`hooks/ctx.ts`) reaches each package by a
relative path, never through `node_modules`.

## License

[Apache-2.0](LICENSE) © 2026 Sergei Tarassov
