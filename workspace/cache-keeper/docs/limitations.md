# Limitations

- **A session blocked on its own long tool call is not held.** `Stop` does not fire mid-turn.
- **The 5-hour usage window is invisible.** Hooks never see response headers, so the keeper cannot back off when
  the window is nearly full.
- **Without the mod, each wake is a real (tiny) turn.** It appears in the transcript and runs your other
  `UserPromptSubmit` hooks; their output is part of the ~1k tokens a wake writes. [Fork pings](fork-pings.md) avoid
  that where the plugin's mod loads.
- **`claude -p` is skipped on purpose.** In print mode async hooks are not backgrounded, so the waiter would hold
  a one-shot run open; it detects `CLAUDE_CODE_ENTRYPOINT=sdk-cli` and returns at once.
- **No Windows support** — the waiter uses POSIX `sleep`.
- Presence needs a desktop: on a headless Linux box, or a session started without its desktop's session bus, only
  logind can answer, and without a graphical session nobody does; then the away budget is the only cap while you are
  away. A desktop with its idle delay off never sets logind's hint, so there the precise probes are the only signal.
