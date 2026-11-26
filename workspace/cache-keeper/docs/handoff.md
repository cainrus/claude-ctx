# Handoff

<!-- gen:module src/handoff.ts -->
Handoff: when keeper is about to let a large, still-warm cache die (you are away for hours, or the ping
budget is spent), it spends one last warm turn on a brief for a new session, `handoffs/<session>.md`.
It is a real turn (in the transcript, about two requests) and renews the cache for another hour.
Back while the cache is still warm, nothing is asked. Back after it went
cold, your prompt is held before it reaches the model and a menu offers: send it again (or `1`) to continue
here, or `2` to start a new session from the brief plus your message (`handoff.spawnCommand`;
`handoff.closeAfterSpawn` closes this one). Where the plugin's mod loads, `!` commands, slash commands and
`/compact` are held the same way. Off by default: turn on with `handoff.enabled` or `CTX_KEEPER_HANDOFF=1`.
<!-- /gen:module -->

The menu, on the first prompt into a cold cache:

```
cache-keeper: this session's prompt cache has gone cold (idle 2h 10m); the next turn re-sends ~151k tokens (≈ $1.51).
A handoff brief was written before it expired: ~/.claude-ctx/keeper/handoffs/<session>.md
  Enter  send the same message again to continue here (or type 1)
  2      continue in a new session from the brief, with your message; this session closes
Your message is held and is back in the input box. Nothing was sent to the model.
```

- Nobody at the input box gets no menu. A session whose `skipIf` exits 3 (it has a holder) goes straight to `2`.
  In a background session a message from another session or a task notification continues here and pays the
  rewrite (`handoff-here`, `detail: "unattended"`).
- A task list in the session is copied into the brief, and the new session recreates it before anything else.

## The gate

<!-- gen:module hooks/gate.ts -->
The gate: a `!` command, a built-in slash command and `/compact` reach the
model without the `UserPromptSubmit` hook, so they would hit a cold cache with
no menu. The gate asks keeper at the first model request of such a turn and
before a manual `/compact`, and stops the input just as a typed prompt would be
stopped: the menu when a handoff brief waits on a cold cache (`handoff.enabled`),
or keeper's own answer to `/ctx:status`. It runs where Claude Code
loads the plugin's mod; any failure lets the input through.
<!-- /gen:module -->

## Settings

Keys of the `handoff` block in `config.json`:

<!-- gen:handoff-settings -->
| key | env | default | meaning |
|---|---|---|---|
| `enabled` | `CTX_KEEPER_HANDOFF` | `false` | write a brief before the cache dies and ask before a prompt hits it cold (see [Handoff](handoff.md)) |
| `minCtxTokens` | `CTX_KEEPER_HANDOFF_MIN_CTX_TOKENS` | `120000` | below this a brief saves too little |
| `spawnCommand` | `CTX_KEEPER_HANDOFF_SPAWN` | — | shell command starting a new session; gets `CTX_KEEPER_BRIEF`, `CTX_KEEPER_SESSION_ID`, `CTX_KEEPER_TRANSCRIPT_PATH`, `CTX_KEEPER_CWD`; 45 s at most |
| `closeAfterSpawn` | `CTX_KEEPER_HANDOFF_CLOSE` | `true` | close the old session after a successful spawn |
| `closeCommand` | — | SIGTERM to the session's `claude` | how to close it; gets `CTX_KEEPER_SESSION_ID`, `CTX_KEEPER_CLAUDE_PID` |
<!-- /gen:handoff-settings -->

Example: `"spawnCommand": "claude-new-session --prompt-file \"$CTX_KEEPER_BRIEF\" --cwd \"$CTX_KEEPER_CWD\""`.
