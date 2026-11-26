/**
 * The band (hooks/band.ts): the row it draws for each line, and its buttons
 * end to end. ✓ runs the real CLI against a temporary keeper home; the engine
 * is faked, and `h` builds plain objects so a test can walk the tree.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { record } from '../src/commands.ts'
import { loadSession } from '../src/state.ts'
import { bandOn, LEGEND, partsOf, renderBand, setBand, type BandView } from '../hooks/band.ts'
import { configFor, makeCtx, MIN, PLUGIN_ROOT, SID, tempHome, writeTranscript } from './helpers.ts'

const T = 1_800_000_000_000

type Node = { tag: string; props: Record<string, unknown>; children: unknown[] }
const g = globalThis as Record<string, unknown>
g.h = (tag: { name: string }, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ tag: tag.name, props: props ?? {}, children })

const view = (over: Partial<BandView> = {}, line: Partial<Extract<BandView['line'], { kind: 'cached' }>> = {}): BandView => ({
  line: { kind: 'cached', left: 3, extends: true, warmUntil: T, heldUntil: T, pingsUsd: 0, ...line },
  offsetMin: 0,
  muted: false,
  ...over,
})

test('the row: time, pings left, done and the legend button', () => {
  assert.deepEqual(partsOf(view(), false), [
    { text: '◉ 08:00' },
    { key: 'ping', label: '↻3' },
    { key: 'done', label: '✓' },
    { key: 'help', label: '?' },
  ])
})

test('the row carries the range and the money as the status line prints them', () => {
  const parts = partsOf(view({}, { heldUntil: T + 150 * 60_000, pingsUsd: 0.17, nextWarmUsd: 0.05, holdUsd: 0.15 }), false)
  assert.deepEqual(parts.slice(0, 3), [{ text: '◉ 08:00→~10:30' }, { key: 'ping', label: '↻3' }, { text: '(17+5+15)¢', dim: true }])
})

test('no ping coming reads final; a running turn holds the ping button back', () => {
  assert.deepEqual(partsOf(view({}, { extends: false }), false)[1], { text: 'final', dim: true })
  assert.deepEqual(partsOf(view(), true)[1], { text: '↻3', dim: true })
})

test('a muted session shows done, not a button; cold and fresh lines have only the legend', () => {
  assert.deepEqual(partsOf(view({ muted: true }, { extends: false }), false)[2], { text: '✓ done', dim: true })
  assert.deepEqual(partsOf(view({ line: { kind: 'expired' } }), false), [{ text: '○ cold', color: 'success' }, { key: 'help', label: '?' }])
  assert.deepEqual(partsOf(view({ line: { kind: 'expired', nextColdUsd: 0.98 } }), false), [{ text: '○ cold · ↺98¢', color: 'success' }, { key: 'help', label: '?' }])
  assert.deepEqual(partsOf(view({ line: { kind: 'ready' } }), false), [{ text: '○ ready' }, { key: 'help', label: '?' }])
})

test('the time goes yellow in the warning window, and nowhere else', () => {
  assert.deepEqual(partsOf(view({}, { warn: true }), false)[0], { text: '◉ 08:00', color: 'warning' })
  assert.deepEqual(partsOf(view({}, {}), false)[0], { text: '◉ 08:00' })
  assert.equal('color' in partsOf(view({ line: { kind: 'ready' } }), false)[0]!, false)
})

test('the cold row is green and carries the first-turn price of a new session', () => {
  assert.deepEqual(partsOf(view({ line: { kind: 'expired', nextColdUsd: 0.98, ctxTokens: 277_000, coldStartUsd: 0.3 } }), false)[0], { text: '○ cold · ↺277k=98¢ ⇄≥30¢', color: 'success' })
})

test('the legend says what the colours and the new-session price mean', () => {
  assert.match(LEGEND, /↺N=X ⇄≥Y/)
  assert.match(LEGEND, /at least Y/)
  assert.match(LEGEND, /one unit for the whole sum/)
  assert.match(LEGEND, /yellow time: the cache ends soon \(10 minutes, or half the bucket when that is shorter\)/)
  assert.match(LEGEND, /green/)
})

test('a coloured part reaches the Text element as its colour; a plain one carries none', async () => {
  const { $ } = fakeEngine(tempHome())
  setBand($ as never, view({}, { warn: true }))
  const warm = await renderBand($ as never, e, next, async () => {})
  assert.equal(find(warm, (n) => n.tag === 'Text' && n.children[0] === '◉ 08:00')?.props.color, 'warning')
  setBand($ as never, view({ line: { kind: 'expired', nextColdUsd: 0.98 } }))
  const cold = await renderBand($ as never, e, next, async () => {})
  assert.equal(find(cold, (n) => n.tag === 'Text' && n.children[0] === '○ cold · ↺98¢')?.props.color, 'success')
  setBand($ as never, view())
  const plain = await renderBand($ as never, e, next, async () => {})
  assert.equal('color' in (find(plain, (n) => n.tag === 'Text' && n.children[0] === '◉ 08:00')?.props ?? {}), false)
})

test('the band is on unless config says "band": false', () => {
  assert.equal(bandOn({}), true)
  assert.equal(bandOn({ band: false }), false)
})

function fakeEngine(home: string) {
  const toasts: string[] = []
  let redraws = 0
  const cliEnv: NodeJS.ProcessEnv = { HOME: '/nonexistent', CACHE_KEEPER_HOME: home }
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CACHE_KEEPER_') && !(k in cliEnv)) cliEnv[k] = v
  const $ = {
    plugin: { root: PLUGIN_ROOT },
    session: { id: async () => SID },
    process: {
      run: async (argv: string[], opts: { stdin: string }) => {
        const r = spawnSync(argv[0], argv.slice(1), { input: opts.stdin, encoding: 'utf8', env: cliEnv })
        return { exitCode: r.status ?? 1, stdout: r.stdout }
      },
    },
    ui: {
      resolve: () => ({ Box: function Box() {}, Button: function Button() {}, Text: function Text() {} }),
      invalidate: () => void redraws++,
      toast: (t: string) => void toasts.push(t),
    },
  }
  return { $, toasts, redraws: () => redraws }
}

const e = { props: { hasSurvey: false, isWorking: false } }
const next = () => 'engine'

function find(n: unknown, pred: (n: Node) => boolean): Node | undefined {
  if (!n || typeof n !== 'object' || !('tag' in n)) return undefined
  const node = n as Node
  if (pred(node)) return node
  for (const c of node.children) {
    const hit = find(c, pred)
    if (hit) return hit
  }
  return undefined
}

test('no view or a survey leaves the band to the engine', async () => {
  const { $ } = fakeEngine(tempHome())
  setBand($ as never, undefined)
  assert.equal(await renderBand($ as never, e, next, async () => {}), 'engine')
  setBand($ as never, view())
  assert.equal(await renderBand($ as never, { props: { hasSurvey: true, isWorking: false } }, next, async () => {}), 'engine')
})

test('the legend hides until hovered, and ? pins it', async () => {
  const { $, redraws } = fakeEngine(tempHome())
  setBand($ as never, view())
  const before = redraws()
  const tree = await renderBand($ as never, e, next, async () => {})
  const hidden = find(tree, (n) => n.props.display === 'none')
  assert.deepEqual(hidden?.props.hover, { display: 'flex' })
  assert.equal((find(hidden, (n) => n.tag === 'Text')?.children[0]), LEGEND)
  const help = find(tree, (n) => n.props.key === 'help')!
  ;(help.props.onPress as () => void)()
  assert.equal(redraws(), before + 1)
  const pinned = await renderBand($ as never, e, next, async () => {})
  assert.equal(find(pinned, (n) => n.props.display === 'none'), undefined)
  ;(find(pinned, (n) => n.props.key === 'help')!.props.onPress as () => void)()
})

test('✓ marks the session done through the CLI, says so, and refreshes', async () => {
  const home = tempHome()
  const config = configFor(home, {})
  const at = Date.now() - 5 * MIN
  record({ session_id: SID, transcript_path: writeTranscript(home, [{ at, read: 90_000, write: 1_000 }]) }, makeCtx(config, at + 500))
  const { $, toasts } = fakeEngine(home)
  setBand($ as never, view())
  let refreshed = 0
  const tree = await renderBand($ as never, e, next, async () => void refreshed++)
  ;(find(tree, (n) => n.props.key === 'done')!.props.onPress as () => void)()
  for (let i = 0; i < 100 && refreshed === 0; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(refreshed, 1)
  assert.match(toasts[0], /will not be kept warm/)
  assert.ok(loadSession(home, SID)!.doneAt !== undefined)
})
