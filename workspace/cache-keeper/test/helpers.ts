import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from '../src/commands.ts'
import { loadConfig, type Config } from '../src/config.ts'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
/** The claude-ctx plugin root: `${CLAUDE_PLUGIN_ROOT}` and `$.plugin.root` name it, this package sits at workspace/cache-keeper under it. */
export const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const SID = '00000000-0000-4000-8000-00000000abcd'
export const MIN = 60_000

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'cache-keeper-test-'))
}

export function configFor(home: string, env: Record<string, string> = {}): Config {
  return loadConfig({ HOME: '/nonexistent', CACHE_KEEPER_HOME: home, ...env })
}

export interface TestCtx extends Ctx {
  errors: string[]
  probes: number
  /** Total ms `record` asked to sleep while waiting for the transcript. */
  slept: number
}

export function makeCtx(config: Config, now: number, idle: number | null = 0): TestCtx {
  const ctx: TestCtx = {
    config,
    now,
    errors: [],
    probes: 0,
    slept: 0,
    sleepMs: (ms) => {
      ctx.slept += ms
    },
    idleSeconds: () => {
      ctx.probes++
      return idle
    },
    stderr: (t) => ctx.errors.push(t),
  }
  return ctx
}

export interface UsageSpec {
  at: number
  input?: number
  read?: number
  write?: number
  output?: number
  model?: string
  /** The API's `cache_creation` split of `write`, tokens written for 1 hour and for 5 minutes. */
  split?: { h1?: number; m5?: number }
}

/** A main-thread `user` entry: a prompt (string content), or any content the test gives. */
export function userLine(at: number, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', isSidechain: false, sessionId: SID, timestamp: new Date(at).toISOString(), message: { role: 'user', content }, ...extra })
}

export function assistantLine(u: UsageSpec, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    cwd: '/home/user/project',
    timestamp: new Date(u.at).toISOString(),
    message: {
      model: u.model ?? 'claude-opus-4-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: u.input ?? 5,
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
        output_tokens: u.output ?? 10,
        ...(u.split ? { cache_creation: { ephemeral_1h_input_tokens: u.split.h1 ?? 0, ephemeral_5m_input_tokens: u.split.m5 ?? 0 } } : {}),
      },
    },
    ...extra,
  })
}

/** Write a transcript from raw lines. */
export function writeLines(dir: string, lines: string[], name = 'transcript.jsonl'): string {
  const path = join(dir, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/** Write a transcript whose last main-thread turn has the given usage. */
export function writeTranscript(dir: string, turns: UsageSpec[], name = 'transcript.jsonl'): string {
  return writeLines(dir, turns.map((t) => assistantLine(t)), name)
}

/** One row per case: the bucket a usage object wrote (src/transcript.ts `ttlOfUsage` and the mod's copy in hooks/status.ts). */
export const TTL_OF_USAGE_CASES: Array<{ name: string; usage: unknown; ttlSec: 300 | 3600 | undefined }> = [
  { name: 'only 1-hour tokens', usage: { cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } }, ttlSec: 3600 },
  { name: 'only 5-minute tokens', usage: { cache_creation: { ephemeral_5m_input_tokens: 5 } }, ttlSec: 300 },
  { name: 'both: 1 hour wins', usage: { cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 9 } }, ttlSec: 3600 },
  { name: 'an empty split', usage: { cache_creation: {} }, ttlSec: undefined },
  { name: 'a zero split', usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }, ttlSec: undefined },
  { name: 'no split', usage: { input_tokens: 4 }, ttlSec: undefined },
  { name: 'an empty usage', usage: {}, ttlSec: undefined },
  { name: 'a non-number count', usage: { cache_creation: { ephemeral_1h_input_tokens: '5' } }, ttlSec: undefined },
]

const AT = Date.UTC(2026, 0, 1, 10, 0, 0)

/** One row per case: does this transcript line start a model request? A tool result, a prompt or a skill expansion does; a line the client writes itself, a summary or an interrupt note does not. */
export const REQUEST_START_CASES: Array<{ name: string; line: string; starts: boolean }> = [
  { name: 'a typed prompt', line: userLine(AT, 'fix the bug'), starts: true },
  { name: 'a prompt in a text block', line: userLine(AT, [{ type: 'text', text: 'fix the bug' }]), starts: true },
  { name: 'a tool result', line: userLine(AT, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), starts: true },
  { name: 'a tool result whose text looks like a command tag', line: userLine(AT, [{ type: 'tool_result', content: '<command-name>x</command-name>' }]), starts: true },
  { name: 'a skill expansion (isMeta)', line: userLine(AT, 'Base directory for this skill: /x', { isMeta: true }), starts: true },
  { name: 'a task notification', line: userLine(AT, '<task-notification>done</task-notification>'), starts: true },
  { name: 'a compaction summary', line: userLine(AT, 'This session is being continued', { isCompactSummary: true }), starts: false },
  { name: 'a slash command line', line: userLine(AT, '<command-name>/model</command-name>'), starts: false },
  { name: 'a command message', line: userLine(AT, '<command-message>x</command-message>'), starts: false },
  { name: 'command args', line: userLine(AT, '  <command-args>x</command-args>'), starts: false },
  { name: 'local command output', line: userLine(AT, '<local-command-stdout>ok</local-command-stdout>'), starts: false },
  { name: 'local command stderr', line: userLine(AT, '<local-command-stderr>no</local-command-stderr>'), starts: false },
  { name: 'local command caveat', line: userLine(AT, '<local-command-caveat>c</local-command-caveat>'), starts: false },
  { name: 'a bang command', line: userLine(AT, '<bash-input>ls</bash-input>'), starts: false },
  { name: 'bang command output', line: userLine(AT, '<bash-stdout>x</bash-stdout>'), starts: false },
  { name: 'bang command stderr', line: userLine(AT, '<bash-stderr>x</bash-stderr>'), starts: false },
  { name: 'an interrupt note', line: userLine(AT, [{ type: 'text', text: '[Request interrupted by user]' }]), starts: false },
  { name: 'a sidechain prompt', line: userLine(AT, 'sub task', { isSidechain: true }), starts: false },
  { name: 'an assistant entry', line: assistantLine({ at: AT, read: 1 }), starts: false },
  { name: 'an entry without a timestamp', line: JSON.stringify({ type: 'user', message: { content: 'x' } }), starts: false },
  { name: 'junk', line: '{"type":"user", torn', starts: false },
]
export const REQUEST_START_AT = AT
