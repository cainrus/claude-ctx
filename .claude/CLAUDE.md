# claude-ctx: how code and docs are written here

A monorepo: the plugin `ctx` at the root is assembled from the packages in `workspace/*`. The root holds only the
manifests, `hooks/hooks.json` (built by `node scripts/hooks.ts`) and `hooks/ctx.ts`, the one hooks module that
registers each package's hooks. A package owns its events, settings, state and docs; the plugin installs from git
with no `npm install`, so the root reaches a package by relative path only, never through `node_modules`.

A package's docs are built from its code (cache-keeper: `node workspace/cache-keeper/scripts/docs.ts`; its
`test/docs.test.ts` fails when they are stale). So write code text as if it were already a docs line: short, for a
human and a model alike.

## Where text lives

| text | where | rule |
|---|---|---|
| what a user-visible module does | its header `/** … */`, first thing in the file | up to ~8 lines: what, when it acts, how to turn it off. No history, no measurements. Rendered into `docs/<topic>.md` |
| facts the code holds as data (settings, ledger events, status lines, policy rows) | a table in code (`SETTINGS`, `LEDGER_EVENTS`, …) | one line per entry; the type is derived from the table, so an entry without a description does not exist |
| a non-obvious why | a guard comment at the line it guards | rendered into `docs/guardrails.md` with file:line |
| anything else | nowhere | code says it |

## Code style

1. **Names say the exact action and target.** No `process`, `handle`, `manage`, `data`, `temp`. A name that needs
   "and" is two functions. Hook command names (`record`, `touch`, `wake`, `end`, `gate`, ...) are public: they are in
   `hooks/hooks.json` and in users' settings, so they do not change.
2. **Comments say why, never what.** No JSDoc on internal functions; exported API gets one line only when the name
   and types do not say it.
3. **Guard comments** for edge cases and fragile logic, one of:
   - `// INVARIANT:` a rule that must never be broken
   - `// WORKAROUND:` a fix for an external bug or limit; name the version or issue
   - `// WARNING:` a hidden side effect or an order the code depends on
4. **Never delete or change an `INVARIANT`, `WORKAROUND` or `WARNING` without the owner's explicit yes.**
