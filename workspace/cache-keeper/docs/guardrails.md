# Guardrails

The non-obvious whys of the code, collected from its `INVARIANT`, `WORKAROUND` and `WARNING` comments. For
contributors and for agents editing the code: none of these may be removed or changed without the owner's yes.

<!-- gen:guardrails -->
## Invariants

- [`src/cold-stop.ts:97`](../src/cold-stop.ts#L97) never held, by keeper or by blockIf: nobody resends a machine's prompt, and its sender reads "delivered".
- [`src/cold-stop.ts:165`](../src/cold-stop.ts#L165) a pass never skips a price nobody showed: with keeper's stop due, keeper decides (the menu too, see touch).
- [`src/commands.ts:148`](../src/commands.ts#L148) hooks/keepalive.ts `isPingTurn` is the mod's copy of this test; keep the two in step.
- [`src/commands.ts:166`](../src/commands.ts#L166) a turn the gate (or the mod) answered never reached the model: its Stop must not read as a touched cache.
- [`src/commands.ts:210`](../src/commands.ts#L210) only a Stop after our own wake turn is scored, never on `stop_hook_active` alone (another Stop hook may have blocked the turn: a spurious miss would mute the session for good). A fork is scored by `forked`.
- [`src/commands.ts:302`](../src/commands.ts#L302) a turn held open by a question (fork.ts waitStart) takes only forks: a wake turn or a handoff would land inside it.
- [`src/fork.ts:171`](../src/fork.ts#L171) the mod's own limit on one fork, hooks/keepalive.ts FORK_TIMEOUT_MS; keep the two in step.
- [`src/fork.ts:194`](../src/fork.ts#L194) no fallback turn once the person is back or a question holds the turn open: it would land inside their turn. Nothing goes out past maxAgeSec (measured: a fallback delayed by an outage landed 13 min late and wrote 436k).
- [`src/fork.ts:286`](../src/fork.ts#L286) a band press has no command turn, so it marks no Stop as the gate's and leaves nothing for a turn to close.
- [`src/handoff-run.ts:7`](../src/handoff-run.ts#L7) below the 60 s of TOUCH_TIMEOUT_SEC (hooks.ts) and GATE_TIMEOUT_MS (hooks/gate.ts), with room for the rest of the hook.
- [`src/handoff-run.ts:41`](../src/handoff-run.ts#L41) session titles as `ps -o comm=` prints them (macOS, Claude Code 2.1.303-2.1.304). The daemon `…/.local/bin/claude` and `claude bg-pty-host` must never match, nor may the walk pass an unknown `claude` title: closing the daemon ends every background session.
- [`src/handoff.ts:333`](../src/handoff.ts#L333) cold is readWarmth's verdict, the one every stop and `status --json` read: a second rule here once burned the brief as warm while another stop called the session cold.
- [`src/handoff.ts:341`](../src/handoff.ts#L341) a background session has nobody to answer the menu: a held peer message or task notification would freeze it while its sender reads "delivered". It pays the cold turn here; a handoff would leave the sender writing to a closed session.
- [`src/handoff.ts:358`](../src/handoff.ts#L358) once the menu is shown its answer decides: `auto` would take the reply (`1`, `2`) as the message.
- [`src/hooks.ts:5`](../src/hooks.ts#L5) every hook enters through bin/cache-keeper.sh: without a usable node it exits 0 in silence (`check` says why).
- [`src/ledger.ts:72`](../src/ledger.ts#L72) one small line per O_APPEND write, so concurrent hooks interleave whole lines.
- [`src/policy.ts:69`](../src/policy.ts#L69) null (an unknown probe) is neither at the keyboard nor gone: read as present, a broken probe would lift the away budget, the only machine-wide cap.
- [`src/policy.ts:75`](../src/policy.ts#L75) branch order is the policy and must match SKIP_REASONS: it decides which reason the ledger blames.
- [`src/presence.ts:79`](../src/presence.ts#L79) trusted only with a graphical session: without a desktop to set it, IdleHint can stay "no" forever, read as "at the keyboard", and lift the away budget.
- [`src/state.ts:95`](../src/state.ts#L95) an id that is not a plain UUID is flattened so it cannot escape the sessions directory.
- [`src/transcript.ts:33`](../src/transcript.ts#L33) hooks/status.ts `ttlOfUsage` is the mod's copy of this rule (it also reads the flat form of a `turn.step` usage); keep the two in step (test/status.test.ts runs one table on both).
- [`src/transcript.ts:55`](../src/transcript.ts#L55) sidechain (subagent) and synthetic entries are skipped: their usage is not the main thread's cache.
- [`src/warmth.ts:62`](../src/warmth.ts#L62) a reader takes ids from outside (a hook payload, a CLI argument): only an id the writers' safeId leaves as it is reaches a path or the ledger match.
- [`src/warmth.ts:185`](../src/warmth.ts#L185) no usage is no request: the mod's gate answers a turn itself with `usage: null`, and as a touch it read a cold session warm for 55 min.
- [`src/warmth.ts:198`](../src/warmth.ts#L198) a subagent's entry (isSidechain) renews its own cache, not the main thread's (as src/transcript.ts skips it).
- [`hooks/band.ts:145`](../hooks/band.ts#L145) a failure draws what the engine would: the band must never break a session.
- [`hooks/gate.ts:129`](../hooks/gate.ts#L129) fail open: a timeout, a spawn failure or output that is not JSON lets the input through.
- [`hooks/keepalive.ts:34`](../hooks/keepalive.ts#L34) once a question is answered nothing arms until its turn's turn.complete: a fork's result would re-arm inside the turn.
- [`hooks/keepalive.ts:160`](../hooks/keepalive.ts#L160) a turn ending under a fork in flight does not claim: the fork's own result re-arms.
- [`hooks/keepalive.ts:193`](../hooks/keepalive.ts#L193) the same test as src/commands.ts isPingCommand (the mod cannot import it). A command's turn begins with its tag (seen on Claude Code 2.1.321); anchored at the start, so a message that merely quotes it is a message.
- [`hooks/keepalive.ts:215`](../hooks/keepalive.ts#L215) not while an answered question's turn runs: nothing arms until its turn.complete.
- [`hooks/keepalive.ts:221`](../hooks/keepalive.ts#L221) never a second request on top of a fork that went out, even when the CLI did not record it.
- [`hooks/status.ts:23`](../hooks/status.ts#L23) a missing TTL reads as one hour: a wrong guess that way stays silent, the other way tells a person to pay for a re-read they did not need.
- [`hooks/status.ts:106`](../hooks/status.ts#L106) mirrors keeper's rules (src/config.ts resolution order, policy.ts muting on a miss or done); the mod cannot import them.
- [`hooks/status.ts:222`](../hooks/status.ts#L222) src/transcript.ts `ttlOfUsage` is the source of this rule for the split form (the mod cannot import src/); keep the two in step.
- [`hooks/status.ts:281`](../hooks/status.ts#L281) every failure clears the line: a status must never break a session.
- [`bin/cache-keeper.sh:45`](../bin/cache-keeper.sh#L45) reads "off" as src/config.ts does (env first, trimmed, any case, and it turns keeper back on over the file; else a top-level "enabled" of false/"false"/"no"/"off"/"0"); nested objects are cut out first (handoff's own "enabled").
- [`bin/cache-keeper.ts:109`](../bin/cache-keeper.ts#L109) a hook must never break the session it runs in: any failure is exit 0 and leaves a trace (errors.ts).

## Workarounds

- [`src/commands.ts:103`](../src/commands.ts#L103) the Stop hook can run before Claude Code flushed the turn's assistant entry (seen live), and a read then returns the PREVIOUS turn's usage. Poll for an entry no older than the turn's start; undefined = record it unscored.
- [`src/fork.ts:128`](../src/fork.ts#L128) the open turn gets no Stop, so no sleeper; an answer an hour later rewrote the whole context (#3683: 8 such rewrites in a week, longest wait 45 h). The asking request just renewed the cache: the stretch starts now.
- [`src/fork.ts:348`](../src/fork.ts#L348) anthropics/claude-code#105017: a fork renews the server's cache but not Claude Code's clock, so a compaction that sees no main-thread request within the TTL drops its cache markers and sends the whole context uncached.
- [`src/handoff-run.ts:16`](../src/handoff-run.ts#L16) with CLAUDECODE / CLAUDE_CODE_* set a nested `claude` writes no transcript and `--resume` finds nothing.
- [`src/hooks.ts:20`](../src/hooks.ts#L20) under `claude -p` (sdk-cli) async hooks are not backgrounded, so the sleep would hold a one-shot run open.
- [`src/presence.ts:145`](../src/presence.ts#L145) Claude Code 2.1.332 stamps a background job's launch prompt as typed (origin `composer`), so it read as the person's own; the job keeps that prompt as `intent` in $CLAUDE_JOB_DIR/state.json, and only a prompt equal to it is told apart.
- [`src/state.ts:182`](../src/state.ts#L182) measured, a fork after /compact sent the compacted 42k uncached and wrote none of it; a wake turn would write it all, which the person's own next turn pays anyway.
- [`src/transcript.ts:65`](../src/transcript.ts#L65) an error turn under another name has all-zero usage; reading it would zero the context.
- [`hooks/gate.ts:14`](../hooks/gate.ts#L14) Node needs the `.ts` suffix under `npm test`, but the validator's compiler rejects it (TS5097) and reads no tsconfig of ours. @ts-ignore covers the next line only, so each import stays on one line.
- [`hooks/gate.ts:153`](../hooks/gate.ts#L153) UserPromptSubmit never fires for a `!` command or a built-in slash command (measured on Claude Code 2.1.301), so they are gated here, at the turn's first model request; a refusal sends none.
- [`hooks/keepalive.ts:18`](../hooks/keepalive.ts#L18) `$.model.fork` has no timeout of its own (anthropics/claude-code#101446).
- [`hooks/keepalive.ts:131`](../hooks/keepalive.ts#L131) the engine does not raise a plugin's own compaction in its own hooks (measured: "skipped: re-entry"), so gate.ts never sees this one and `compacted` is reported from here.
- [`bin/cache-keeper.sh:8`](../bin/cache-keeper.sh#L8) Claude Code brings no Node of its own (the native install is one binary) and `/plugin install` checks none, so a missing or old one would fail without a word.

## Warnings

- [`src/cold-stop.ts:60`](../src/cold-stop.ts#L60) stdout goes to a file, not a pipe: a grandchild that keeps a pipe open (`curl … | jq`) holds spawnSync past its timeout until the hook itself is killed, which lets the prompt through and lifts keeper's stop.
- [`src/cold-stop.ts:73`](../src/cold-stop.ts#L73) a command that exits without reading stdin leaves EPIPE in r.error beside a real exit status; only an error with no status is no answer.
- [`src/cold-stop.ts:183`](../src/cold-stop.ts#L183) the ack stays for its whole window: the gate's ask and a follow-up typed while the resent turn runs still read cold. once per stop: the first prompt through after it (touch moves lastHumanAt past the stop), not each follow-up
- [`src/commands.ts:180`](../src/commands.ts#L180) the TTL restarted at the last assistant entry's timestamp, not this hook's clock. With delay == minAgeSec, "now" could land after the sleeper this Stop started and make it look stale. An entry older than the last prompt = not caught up: now.
- [`src/commands.ts:184`](../src/commands.ts#L184) lastRequestAt stays Claude Code's own clock (compactedSinceRequest, compactCheck's #105017 test read it): never the request start.
- [`src/commands.ts:187`](../src/commands.ts#L187) the prompt's transcript entry is stamped before UserPromptSubmit runs (median 0.9 s, p25 1.4 s earlier on 243 sessions, 26.11.2026), so "inside this turn" starts PROMPT_STAMP_SLACK_MS before turnBegan; without it a turn with no tool call never anchors at its start.
- [`src/commands.ts:431`](../src/commands.ts#L431) the mod's gate asks at every turn's first request; the prompt the UserPromptSubmit hook let through just before met the stops there (blockIf asked once). Its stamp, matched by the text, is spent by that one ask.
- [`src/commands.ts:440`](../src/commands.ts#L440) blockIf before the handoff menu: the menu marks its brief used as it answers, and a later hold would burn it.
- [`src/fork.ts:78`](../src/fork.ts#L78) a fork in flight did not survive the reload: nothing will score it, nor will the turn that fork answered end in a Stop the gate mark could wait for.
- [`src/fork.ts:117`](../src/fork.ts#L117) prints nothing: a SessionStart hook's stdout reaches the model.
- [`src/fork.ts:309`](../src/fork.ts#L309) with a fork the mod answers the command's turn, even if the CLI fails after it: that Stop is the mod's. Marked as of the fork's latest end, so a slow one does not push the Stop out of the window.
- [`src/handoff-run.ts:74`](../src/handoff-run.ts#L74) detached and delayed by CLOSE_DELAY_SEC: killing the session kills this hook, which must answer first.
- [`src/handoff.ts:187`](../src/handoff.ts#L187) matches Claude Code's own wrapping of a peer message or task notification (`<cross-session-message …>`, `<task-notification>`, maybe after a one-line preamble); if that format changes, they read as typed prompts.
- [`src/presence.ts:104`](../src/presence.ts#L104) order matters. The precise probes need the desktop's session bus or X display, which a hook inherits from an interactive session but not from a daemon-spawned one; logind needs neither, so it is the last resort.
- [`src/presence.ts:164`](../src/presence.ts#L164) Claude Code starts background sessions with CLAUDE_JOB_DIR and stamps their transcript lines "sessionKind":"bg"; hooks inherit the env var, the transcript is the fallback.
- [`src/prices.ts:79`](../src/prices.ts#L79) family keys ("opus", the pre-0.6.6 form) apply first and rewrite every row they name, so a model-prefix override still wins over its family.
- [`src/state.ts:142`](../src/state.ts#L142) a file apart from the session's: the mod claims at turn end, just when `record` rewrites the session file, and one write would drop the other's.
- [`src/state.ts:188`](../src/state.ts#L188) this counts from `lastTurnEndAt` with the config TTL, as the ping timer does. The status line (hooks/status.ts) anchors at `cacheAnchorAt` (the request's start) with the bucket the turn wrote, because that is when the server's clock runs; the two ends can differ.
- [`src/transcript.ts:240`](../src/transcript.ts#L240) decode only whole lines: a chunk edge can cut a multi-byte character, so bytes are carried, not text.
- [`src/transcript.ts:270`](../src/transcript.ts#L270) the first, not the last: when the first request rewrote the context, every later one reads that fresh write and looks like a hit.
- [`src/warmth.ts:182`](../src/warmth.ts#L182) Claude Code writes a synthetic entry (model "<synthetic>", isApiErrorMessage) with zero usage for a refused request, a rate limit say: no touch.
- [`hooks/band.ts:21`](../hooks/band.ts#L21) status.ts imports this module too. Use its functions at call time only: a const of it read while this module loads is not initialised yet.
- [`hooks/gate.ts:47`](../hooks/gate.ts#L47) the chain only advances when this settles, and every later prompt waits on it before next(e). The engine may ignore timeoutMs (or $.session.id / $.clock.now may never answer), so the module races the whole write against its own timer: a hung call costs at most PERSON_TIMEOUT_MS, not every later prompt.
- [`hooks/gate.ts:114`](../hooks/gate.ts#L114) next(e) may not have resolved yet (the turn starts before it does); then the entered write sees `refused` and is never sent.
- [`hooks/gate.ts:177`](../hooks/gate.ts#L177) a plugin loads one hooks module with one hook per event, so the fork pings (keepalive.ts) and the status line (status.ts) are called from these hooks.
- [`hooks/gate.ts:193`](../hooks/gate.ts#L193) recorded before next(e): a settings hook beneath may block the prompt, and the person still typed it; awaited, and calls run on one promise chain (a failure never breaks it), so `persons/<id>.json` is single-writer and its promptAt is on disk before the prompt reaches anyone.
- [`hooks/keepalive.ts:66`](../hooks/keepalive.ts#L66) not awaited: it resolves only once the turn starts, which is after the calling hook returns.
- [`hooks/status.ts:89`](../hooks/status.ts#L89) not lastRequestAt: policy reads that as Claude Code's own clock (src/state.ts). cacheAnchorAt is the status line's own, written by Stop and by a fork ping that renewed the cache.
<!-- /gen:guardrails -->
