# Guardrails

The non-obvious whys of the code, collected from its `INVARIANT`, `WORKAROUND` and `WARNING` comments. For
contributors and for agents editing the code: none of these may be removed or changed without the owner's yes.

<!-- gen:guardrails -->
## Invariants

- [`src/commands.ts:114`](../src/commands.ts#L114) hooks/keepalive.ts `isPingTurn` is the mod's copy of this test; keep the two in step.
- [`src/commands.ts:132`](../src/commands.ts#L132) a turn the gate (or the mod) answered never reached the model: its Stop must not read as a touched cache.
- [`src/commands.ts:158`](../src/commands.ts#L158) only a Stop after our own wake turn is scored, never on `stop_hook_active` alone (another Stop hook may have blocked the turn: a spurious miss would mute the session for good). A fork is scored by `forked`.
- [`src/commands.ts:235`](../src/commands.ts#L235) a turn held open by a question (fork.ts waitStart) takes only forks: a wake turn or a handoff would land inside it.
- [`src/fork.ts:163`](../src/fork.ts#L163) the mod's own limit on one fork, hooks/keepalive.ts FORK_TIMEOUT_MS; keep the two in step.
- [`src/fork.ts:185`](../src/fork.ts#L185) no fallback turn once the person is back or a question holds the turn open: it would land inside their turn. Nothing goes out past maxAgeSec (measured: a fallback delayed by an outage landed 13 min late and wrote 436k).
- [`src/handoff-run.ts:7`](../src/handoff-run.ts#L7) below the 60 s of TOUCH_TIMEOUT_SEC (hooks.ts) and GATE_TIMEOUT_MS (hooks/gate.ts), with room for the rest of the hook.
- [`src/handoff-run.ts:41`](../src/handoff-run.ts#L41) session titles as `ps -o comm=` prints them (macOS, Claude Code 2.1.303-2.1.304). The daemon `…/.local/bin/claude` and `claude bg-pty-host` must never match, nor may the walk pass an unknown `claude` title: closing the daemon ends every background session.
- [`src/handoff.ts:339`](../src/handoff.ts#L339) a background session has nobody to answer the menu: a held peer message or task notification would freeze it while its sender reads "delivered". It pays the cold turn here; a handoff would leave the sender writing to a closed session.
- [`src/handoff.ts:356`](../src/handoff.ts#L356) once the menu is shown its answer decides: `auto` would take the reply (`1`, `2`) as the message.
- [`src/hooks.ts:5`](../src/hooks.ts#L5) every hook enters through bin/cache-keeper.sh: without a usable node it exits 0 in silence (`check` says why).
- [`src/ledger.ts:67`](../src/ledger.ts#L67) one small line per O_APPEND write, so concurrent hooks interleave whole lines.
- [`src/policy.ts:69`](../src/policy.ts#L69) null (an unknown probe) is neither at the keyboard nor gone: read as present, a broken probe would lift the away budget, the only machine-wide cap.
- [`src/policy.ts:75`](../src/policy.ts#L75) branch order is the policy and must match SKIP_REASONS: it decides which reason the ledger blames.
- [`src/presence.ts:77`](../src/presence.ts#L77) trusted only with a graphical session: without a desktop to set it, IdleHint can stay "no" forever, read as "at the keyboard", and lift the away budget.
- [`src/state.ts:79`](../src/state.ts#L79) an id that is not a plain UUID is flattened so it cannot escape the sessions directory.
- [`src/transcript.ts:28`](../src/transcript.ts#L28) sidechain (subagent) and synthetic entries are skipped: their usage is not the main thread's cache.
- [`hooks/band.ts:140`](../hooks/band.ts#L140) a failure draws what the engine would: the band must never break a session.
- [`hooks/gate.ts:36`](../hooks/gate.ts#L36) fail open: a timeout, a spawn failure or output that is not JSON lets the input through.
- [`hooks/keepalive.ts:32`](../hooks/keepalive.ts#L32) once a question is answered nothing arms until its turn's turn.complete: a fork's result would re-arm inside the turn.
- [`hooks/keepalive.ts:150`](../hooks/keepalive.ts#L150) a turn ending under a fork in flight does not claim: the fork's own result re-arms.
- [`hooks/keepalive.ts:183`](../hooks/keepalive.ts#L183) the same test as src/commands.ts isPingCommand (the mod cannot import it). A command's turn begins with its tag (seen on Claude Code 2.1.321); anchored at the start, so a message that merely quotes it is a message.
- [`hooks/keepalive.ts:203`](../hooks/keepalive.ts#L203) never a second request on top of a fork that went out, even when the CLI did not record it.
- [`hooks/status.ts:83`](../hooks/status.ts#L83) mirrors keeper's rules (src/config.ts resolution order, policy.ts muting on a miss or done); the mod cannot import them.
- [`hooks/status.ts:227`](../hooks/status.ts#L227) every failure clears the line: a status must never break a session.
- [`bin/cache-keeper.sh:45`](../bin/cache-keeper.sh#L45) reads "off" as src/config.ts does (env first, trimmed, any case, and it turns keeper back on over the file; else a top-level "enabled" of false/"false"/"no"/"off"/"0"); nested objects are cut out first (handoff's own "enabled").
- [`bin/cache-keeper.ts:98`](../bin/cache-keeper.ts#L98) a hook must never break the session it runs in: any failure is exit 0 and leaves a trace (errors.ts).

## Workarounds

- [`src/commands.ts:71`](../src/commands.ts#L71) the Stop hook can run before Claude Code flushed the turn's assistant entry (seen live), and a read then returns the PREVIOUS turn's usage. Poll for an entry no older than the turn's start; undefined = record it unscored.
- [`src/fork.ts:121`](../src/fork.ts#L121) the open turn gets no Stop, so no sleeper; an answer an hour later rewrote the whole context (#3683: 8 such rewrites in a week, longest wait 45 h). The asking request just renewed the cache: the stretch starts now.
- [`src/fork.ts:317`](../src/fork.ts#L317) anthropics/claude-code#105017: a fork renews the server's cache but not Claude Code's clock, so a compaction that sees no main-thread request within the TTL drops its cache markers and sends the whole context uncached.
- [`src/handoff-run.ts:16`](../src/handoff-run.ts#L16) with CLAUDECODE / CLAUDE_CODE_* set a nested `claude` writes no transcript and `--resume` finds nothing.
- [`src/hooks.ts:20`](../src/hooks.ts#L20) under `claude -p` (sdk-cli) async hooks are not backgrounded, so the sleep would hold a one-shot run open.
- [`src/state.ts:147`](../src/state.ts#L147) measured, a fork after /compact sent the compacted 42k uncached and wrote none of it; a wake turn would write it all, which the person's own next turn pays anyway.
- [`src/transcript.ts:38`](../src/transcript.ts#L38) an error turn under another name has all-zero usage; reading it would zero the context.
- [`hooks/gate.ts:12`](../hooks/gate.ts#L12) Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
- [`hooks/gate.ts:67`](../hooks/gate.ts#L67) UserPromptSubmit never fires for a `!` command or a built-in slash command (measured on Claude Code 2.1.301), so they are gated here, at the turn's first model request; a refusal sends none.
- [`hooks/keepalive.ts:18`](../hooks/keepalive.ts#L18) `$.model.fork` has no timeout of its own (anthropics/claude-code#101446).
- [`hooks/keepalive.ts:121`](../hooks/keepalive.ts#L121) the engine does not raise a plugin's own compaction in its own hooks (measured: "skipped: re-entry"), so gate.ts never sees this one and `compacted` is reported from here.
- [`bin/cache-keeper.sh:8`](../bin/cache-keeper.sh#L8) Claude Code brings no Node of its own (the native install is one binary) and `/plugin install` checks none, so a missing or old one would fail without a word.

## Warnings

- [`src/commands.ts:145`](../src/commands.ts#L145) the TTL restarted at the last assistant entry's timestamp, not this hook's clock. With delay == minAgeSec, "now" could land after the sleeper this Stop started and make it look stale. An entry older than the last prompt = not caught up: now.
- [`src/fork.ts:71`](../src/fork.ts#L71) a fork in flight did not survive the reload: nothing will score it, nor will the turn that fork answered end in a Stop the gate mark could wait for.
- [`src/fork.ts:110`](../src/fork.ts#L110) prints nothing: a SessionStart hook's stdout reaches the model.
- [`src/fork.ts:278`](../src/fork.ts#L278) with a fork the mod answers the command's turn, even if the CLI fails after it: that Stop is the mod's. Marked as of the fork's latest end, so a slow one does not push the Stop out of the window.
- [`src/handoff-run.ts:74`](../src/handoff-run.ts#L74) detached and delayed by CLOSE_DELAY_SEC: killing the session kills this hook, which must answer first.
- [`src/handoff.ts:186`](../src/handoff.ts#L186) matches Claude Code's own wrapping of a peer message or task notification (`<cross-session-message …>`, `<task-notification>`, maybe after a one-line preamble); if that format changes, they read as typed prompts.
- [`src/presence.ts:102`](../src/presence.ts#L102) order matters. The precise probes need the desktop's session bus or X display, which a hook inherits from an interactive session but not from a daemon-spawned one; logind needs neither, so it is the last resort.
- [`src/presence.ts:147`](../src/presence.ts#L147) Claude Code starts background sessions with CLAUDE_JOB_DIR and stamps their transcript lines "sessionKind":"bg"; hooks inherit the env var, the transcript is the fallback.
- [`src/prices.ts:79`](../src/prices.ts#L79) family keys ("opus", the pre-0.6.6 form) apply first and rewrite every row they name, so a model-prefix override still wins over its family.
- [`src/state.ts:107`](../src/state.ts#L107) a file apart from the session's: the mod claims at turn end, just when `record` rewrites the session file, and one write would drop the other's.
- [`src/state.ts:153`](../src/state.ts#L153) hooks/status.ts keeps its own copy (the mod does not import src/); change both together.
- [`src/transcript.ts:94`](../src/transcript.ts#L94) the first, not the last: when the first request rewrote the context, every later one reads that fresh write and looks like a hit.
- [`hooks/band.ts:19`](../hooks/band.ts#L19) status.ts imports this module too. Use its functions at call time only: a const of it read while this module loads is not initialised yet.
- [`hooks/gate.ts:42`](../hooks/gate.ts#L42) a plugin loads one hooks module with one hook per event, so the fork pings (keepalive.ts) and the status line (status.ts) are called from these hooks.
- [`hooks/keepalive.ts:56`](../hooks/keepalive.ts#L56) not awaited: it resolves only once the turn starts, which is after the calling hook returns.
<!-- /gen:guardrails -->
