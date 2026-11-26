import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstMainUsage, firstMainUsageSince, lastMainTurn, lastMainUsage, requestStartFromLine, scanFirstMainUsage, usageFromLine } from '../src/transcript.ts'
import { assistantLine, FIXTURES, REQUEST_START_AT, REQUEST_START_CASES, tempHome, userLine, writeLines } from './helpers.ts'

test('last main-thread usage skips sidechain, synthetic and non-assistant lines', () => {
  const u = lastMainUsage(join(FIXTURES, 'turn.jsonl'))
  assert.deepEqual(u, {
    inputTokens: 6,
    cacheRead: 80_000,
    cacheWrite: 2000,
    outputTokens: 350,
    ctxTokens: 82_006,
    model: 'claude-opus-4-5',
    timestamp: Date.parse('2026-01-01T10:00:30.000Z'),
  })
})

test('missing file and a transcript without usage are undefined', () => {
  assert.equal(lastMainUsage('/nonexistent/transcript.jsonl'), undefined)
  const dir = tempHome()
  const p = join(dir, 'empty.jsonl')
  writeFileSync(p, '{"type":"user","message":{"content":"hi"}}\n')
  assert.equal(lastMainUsage(p), undefined)
})

test('reads past huge trailing lines by widening the window', () => {
  const dir = tempHome()
  const p = join(dir, 'big.jsonl')
  const bigToolResult = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300_000) } })
  writeFileSync(p, `${assistantLine({ at: 0, read: 42_000 })}\n${bigToolResult}\n${bigToolResult}\n`)
  assert.equal(lastMainUsage(p, 1024)?.cacheRead, 42_000)
})

test('firstMainUsageSince: the earliest request at or after the moment, across window widenings', () => {
  const dir = tempHome()
  const p = join(dir, 'resume.jsonl')
  const big = JSON.stringify({ type: 'user', message: { content: 'ü'.repeat(200_000) } })
  const lines = [
    assistantLine({ at: 1_000, read: 1 }),
    assistantLine({ at: 2_000, read: 2 }),
    big,
    assistantLine({ at: 3_000, read: 3 }),
    big,
    assistantLine({ at: 4_000, read: 4 }),
  ]
  writeFileSync(p, `${lines.join('\n')}\n`)
  assert.equal(firstMainUsageSince(p, 2_000, 1024)?.cacheRead, 2)
  assert.equal(firstMainUsageSince(p, 2_500, 1024)?.cacheRead, 3)
  assert.equal(firstMainUsageSince(p, 0, 1024)?.cacheRead, 1)
  assert.equal(firstMainUsageSince(p, 5_000, 1024), undefined)
  assert.equal(lastMainUsage(p, 1024)?.cacheRead, 4)
})

test('a torn last line is ignored', () => {
  const dir = tempHome()
  const p = join(dir, 'torn.jsonl')
  writeFileSync(p, `${assistantLine({ at: 0, read: 1 })}\n${assistantLine({ at: 1, read: 2 }).slice(0, 80)}`)
  assert.equal(lastMainUsage(p)?.cacheRead, 1)
})

test('usageFromLine: missing fields default to zero', () => {
  const u = usageFromLine(JSON.stringify({ type: 'assistant', message: { usage: { cache_read_input_tokens: 7, output_tokens: 3 } } }))
  assert.deepEqual(u, { inputTokens: 0, cacheRead: 7, cacheWrite: 0, outputTokens: 3, ctxTokens: 7 })
  assert.equal(usageFromLine('not json "usage"'), undefined)
})

test('usageFromLine: a turn that sent nothing to the cache is not a usage', () => {
  // Read as a usage it would set the context to 0 and refuse the session as too small.
  assert.equal(usageFromLine(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { output_tokens: 3 } } })), undefined)
  const apiError = { type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 9 } } }
  assert.equal(usageFromLine(JSON.stringify(apiError)), undefined)
})

// --- real-shapes.jsonl: the lines Claude Code actually writes (see make-real-shapes.ts) ---

const REAL = join(FIXTURES, 'real-shapes.jsonl')

test('real shapes: the last usage is the first turn after the compaction, past errors, system lines and junk', () => {
  assert.deepEqual(lastMainUsage(REAL), {
    inputTokens: 6,
    cacheRead: 18_000,
    cacheWrite: 9_500,
    outputTokens: 400,
    ctxTokens: 27_506,
    model: 'claude-opus-5-5',
    timestamp: Date.parse('2026-01-01T10:03:20.000Z'),
    ttlSec: 3600,
  })
})

test('real shapes: the same answer however small the read window', () => {
  for (const chunk of [1024, 2048, 4096, 64 * 1024]) assert.equal(lastMainUsage(REAL, chunk)?.ctxTokens, 27_506, `chunk ${chunk}`)
})

test('real shapes: the first request since a moment before the compaction is the pre-compaction one', () => {
  assert.equal(firstMainUsageSince(REAL, Date.parse('2026-01-01T10:00:00.000Z'), 1024)?.ctxTokens, 160_004)
  assert.equal(firstMainUsageSince(REAL, Date.parse('2026-01-01T10:01:00.000Z'), 1024)?.ctxTokens, 27_506)
  assert.equal(firstMainUsageSince(REAL, Date.parse('2026-01-01T10:04:00.000Z'), 1024), undefined, 'errors are not requests')
})

test('real shapes: the committed fixture is what its generator writes', () => {
  const dir = tempHome()
  const copy = join(dir, 'make-real-shapes.ts')
  writeFileSync(copy, readFileSync(join(FIXTURES, 'make-real-shapes.ts'), 'utf8'))
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', copy])
  assert.equal(readFileSync(join(dir, 'real-shapes.jsonl'), 'utf8'), readFileSync(REAL, 'utf8'))
})

// --- cache bucket, request start, first request ---

const usageOf = (usage: Record<string, unknown>) => usageFromLine(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, ...usage } } }))

test('usageFromLine: the bucket is the 1-hour one when any 1-hour tokens were written, else 5 minutes', () => {
  assert.equal(usageOf({ cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 } })?.ttlSec, 3600)
  assert.equal(usageOf({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 900 } })?.ttlSec, 3600)
  assert.equal(usageOf({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 900 } })?.ttlSec, 300)
})

test('usageFromLine: a read-only turn or a transcript with no split has no bucket', () => {
  assert.equal(usageOf({ cache_read_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })?.ttlSec, undefined)
  assert.equal('ttlSec' in usageOf({ cache_read_input_tokens: 50 })!, false)
  assert.equal('ttlSec' in usageOf({ cache_read_input_tokens: 50, cache_creation: 'x' })!, false)
})

test('requestStartFromLine: which lines start a request', () => {
  for (const c of REQUEST_START_CASES) assert.equal(requestStartFromLine(c.line), c.starts ? REQUEST_START_AT : undefined, c.name)
})

test('lastMainTurn: the last request of the main thread, past local lines, interrupts, sidechains and the answer', () => {
  const dir = tempHome()
  const big = userLine(0, 'ü'.repeat(200_000))
  const p = writeLines(dir, [
    userLine(1_000, 'first'),
    assistantLine({ at: 5_000, read: 1 }),
    big,
    userLine(10_000, [{ type: 'tool_result', content: 'ok' }]),
    userLine(11_000, 'side', { isSidechain: true }),
    assistantLine({ at: 30_000, read: 2 }),
    userLine(31_000, '<local-command-stdout>x</local-command-stdout>'),
    userLine(32_000, '[Request interrupted by user]'),
  ])
  assert.equal(lastMainTurn(p, 1024).requestStart, 10_000)
  assert.equal(lastMainTurn(p).requestStart, 10_000)
  assert.equal(lastMainTurn(p, 1024).usage?.cacheRead, 2)
  assert.deepEqual(lastMainTurn('/nonexistent/t.jsonl'), {})
  assert.equal(lastMainTurn(writeLines(dir, [assistantLine({ at: 1, read: 1 })], 'none.jsonl')).requestStart, undefined)
})

test('firstMainUsage: the first main-thread request from the front, whatever the chunk size', () => {
  const dir = tempHome()
  const p = writeLines(dir, [
    userLine(1_000, 'hello ü ü ü'),
    assistantLine({ at: 2_000, read: 0, write: 12_000, input: 3, model: 'claude-opus-5-5' }, { isSidechain: true }),
    assistantLine({ at: 3_000, read: 0, write: 11_000, input: 4 }),
    assistantLine({ at: 4_000, read: 11_004, write: 50 }),
  ])
  for (const chunk of [7, 64, 1024, 64 * 1024]) {
    const u = firstMainUsage(p, chunk)
    assert.equal(u?.ctxTokens, 11_004, `chunk ${chunk}`)
    assert.equal(u?.timestamp, 3_000)
  }
  assert.equal(firstMainUsage('/nonexistent/t.jsonl'), undefined)
  assert.equal(firstMainUsage(writeLines(dir, [userLine(1, 'x')], 'nousage.jsonl')), undefined)
  // The last line has no newline at the end of the file.
  writeFileSync(join(dir, 'torn.jsonl'), assistantLine({ at: 9, read: 5 }))
  assert.equal(firstMainUsage(join(dir, 'torn.jsonl'), 16)?.cacheRead, 5)
})

test('lastMainTurn: a prompt queued behind the answer is not its request; the latest start before the answer is', () => {
  const p = writeLines(tempHome(), [userLine(1_000, 'first'), userLine(10_000, [{ type: 'tool_result', content: 'ok' }]), assistantLine({ at: 30_000, read: 2 }), userLine(35_000, 'queued')])
  assert.equal(lastMainTurn(p).requestStart, 10_000)
  assert.equal(lastMainTurn(p).usage?.timestamp, 30_000)
})

test('lastMainTurn: the bucket is the last one a request of this turn wrote, a read-only final request included', () => {
  const p = writeLines(tempHome(), [
    userLine(1_000, 'old'),
    assistantLine({ at: 2_000, write: 500, split: { h1: 500 } }),
    userLine(10_000, 'new'),
    assistantLine({ at: 11_000, write: 800, split: { m5: 800 } }),
    userLine(20_000, [{ type: 'tool_result', content: 'ok' }]),
    assistantLine({ at: 30_000, read: 2 }),
  ])
  assert.equal(lastMainTurn(p, 1024, 10_000).ttlSec, 300)
  assert.equal(lastMainTurn(p, 1024, 25_000).ttlSec, undefined, 'a turn that wrote none: the earlier bucket is not its own')
  assert.equal(lastMainTurn(p, 1024, 0).ttlSec, 300)
})

test('lastMainTurn and firstMainUsage stop at the scan cap instead of reading a huge file every Stop', () => {
  const dir = tempHome()
  const pad = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1024 * 1024) })
  const p = writeLines(dir, [assistantLine({ at: 1_000, read: 1 }), ...Array.from({ length: 18 }, () => pad)])
  assert.equal(lastMainTurn(p).usage, undefined, 'the only request lies 18 MiB back')
  const late = writeLines(dir, [...Array.from({ length: 3 }, () => pad), assistantLine({ at: 1_000, read: 1 })], 'late.jsonl')
  assert.equal(firstMainUsage(late, 64 * 1024, 1024 * 1024), undefined)
  assert.equal(firstMainUsage(late)?.cacheRead, 1, 'inside the default cap it is found')
})

test('the readers that predate the scan cap are not capped: firstMainUsageSince and lastMainUsage still find a request more than 16 MiB back', () => {
  const dir = tempHome()
  const pad = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1024 * 1024) })
  const p = writeLines(dir, [assistantLine({ at: 1_000, read: 1 }), ...Array.from({ length: 18 }, () => pad), assistantLine({ at: 2_000, read: 2 })])
  assert.equal(firstMainUsageSince(p, 500)?.cacheRead, 1, 'the first request of the turn, 18 MiB back, not the newest inside the cap')
  const only = writeLines(dir, [assistantLine({ at: 1_000, read: 1 }), ...Array.from({ length: 18 }, () => pad)], 'only.jsonl')
  assert.equal(lastMainUsage(only)?.cacheRead, 1)
  assert.equal(lastMainTurn(only).usage, undefined, 'the new reader stays capped')
})

test('lastMainTurn: the request start is the latest start before the answer in file order, whatever the timestamps say', () => {
  const dir = tempHome()
  const real = userLine(10_000, [{ type: 'tool_result', content: 'ok' }])
  const answer = assistantLine({ at: 30_000, read: 2 })
  // A prompt typed while the answer streamed is stamped before it but written after it: not the request's start.
  const after = writeLines(dir, [userLine(1_000, 'first'), real, answer, userLine(28_000, 'queued')], 'after.jsonl')
  assert.equal(lastMainTurn(after).requestStart, 10_000)
  assert.equal(lastMainTurn(after, 1024).requestStart, 10_000)
  // The same two lines the other way round in the file: file order says the prompt came first, so it is the start.
  const before = writeLines(dir, [userLine(1_000, 'first'), real, userLine(28_000, 'queued'), answer], 'before.jsonl')
  assert.equal(lastMainTurn(before).requestStart, 28_000)
  // Stamped after the answer but written before it: still before it in the file.
  const late = writeLines(dir, [userLine(1_000, 'first'), real, userLine(35_000, 'odd stamp'), answer], 'late.jsonl')
  assert.equal(lastMainTurn(late).requestStart, 35_000)
})

test('scanFirstMainUsage: complete says whether "no usage" is final (end of file, the cap) or an error a later try may not repeat', () => {
  const dir = tempHome()
  assert.deepEqual(scanFirstMainUsage('/nonexistent/t.jsonl'), { complete: false })
  assert.deepEqual(scanFirstMainUsage(writeLines(dir, [userLine(1, 'x')], 'none.jsonl')), { usage: undefined, complete: true })
  const pad = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1024 * 1024) })
  const late = writeLines(dir, [...Array.from({ length: 3 }, () => pad), assistantLine({ at: 1_000, read: 1 })], 'late.jsonl')
  assert.deepEqual(scanFirstMainUsage(late, 64 * 1024, 1024 * 1024), { complete: true })
  const found = scanFirstMainUsage(late)
  assert.equal(found.complete, true)
  assert.equal(found.usage?.cacheRead, 1)
})
