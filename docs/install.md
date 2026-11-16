# Install

Requires Node **≥ 22.18** on `PATH` (on the 23 line, 23.6+) and a POSIX shell; macOS gives the best presence signal.

```sh
node --version   # v22.18.0 or later
claude plugin marketplace add cainrus/claude-cache-keeper
claude plugin install cache-keeper@claude-cache-keeper
```

New sessions, background and agent-view ones included, pick it up. Without the plugin system:

```sh
git clone https://github.com/cainrus/claude-cache-keeper.git
node claude-cache-keeper/bin/cache-keeper.ts install-snippet   # prints a hooks block for ~/.claude/settings.json
```

## No Node, or an old one

<!-- gen:module bin/cache-keeper.sh -->
The Node check: every hook command enters here and runs cache-keeper.ts only
under a `node` on PATH that runs .ts (22.18 or later); without one the hooks
do nothing and exit 0. At session start it then says so in every session, and
once per machine asks the model to offer setting Node up. Keeper turned off
(`"enabled": false` or CACHE_KEEPER_DISABLED=1) stays silent.
<!-- /gen:module -->
