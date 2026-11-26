/** How a wake turn (ping or handoff) asks the model to answer. */
export const WAKE_REPLY =
  'Reply with one short line and no further tools: "ok", or "ok, waiting for <what>" while anything is pending ' +
  '(background work, an answer). This wake is not a stop: an open task stays open, and whatever this session ' +
  'waits for still resumes it.'
