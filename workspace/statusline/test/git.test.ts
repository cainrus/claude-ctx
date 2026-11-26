/**
 * The branch, its marks and the folder worked on, on real repositories in a
 * temp dir: a checkout, a linked worktree, a clone with an upstream. git runs
 * only in the refresher (src/gitcache.ts), never on the drawing path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchOfHead, cacheKey, candidatesOf, dirtyOf, gitFactsOf, parseCounts, passDue, workdirOf, type FsLike } from '../hooks/gitfacts.ts'
import { refreshCounts } from '../src/gitcache.ts'
import { releaseLock, takeLock, withLock } from '../src/lock.ts'

const fs: FsLike = {
  read: (p) => readFile(p, 'utf8'),
  stat: async (p) => {
    const s = await stat(p)
    return { kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', mtimeMs: s.mtimeMs }
  },
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

function repo(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-git-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const origin = join(root, 'origin.git')
  const main = join(root, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', main])
  git(main, 'remote', 'add', 'origin', origin)
  writeFileSync(join(main, 'a.txt'), 'a\n')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'one')
  git(main, 'push', '-q', '-u', 'origin', 'main')
  return { root, origin, main, cache: join(root, 'cache') }
}

test('a checkout: its root, git dir and the project by origin URL', async (t) => {
  const r = repo(t)
  mkdirSync(join(r.main, 'sub'))
  const g = (await gitFactsOf(fs, join(r.main, 'sub')))!
  assert.equal(g.top, r.main)
  assert.equal(g.gitDir, join(r.main, '.git'))
  assert.equal(g.id, r.origin)
  assert.equal(await gitFactsOf(fs, r.root), undefined, 'outside a repository')
})

test('a linked worktree names its own git dir and the main checkout\'s project', async (t) => {
  const r = repo(t)
  const wt = join(r.root, 'wt-feature')
  git(r.main, 'worktree', 'add', '-q', '-b', 'feature', wt)
  const g = (await gitFactsOf(fs, wt))!
  assert.equal(g.top, wt)
  assert.match(g.gitDir, /\.git\/worktrees\/wt-feature$/)
  assert.equal(g.id, r.origin)
  assert.equal(branchOfHead(readFileSync(join(g.gitDir, 'HEAD'), 'utf8')), 'feature')
})

test('detached HEAD shows @ and seven hex digits', () => {
  assert.equal(branchOfHead('0123456789abcdef0123456789abcdef01234567\n'), '@0123456')
  assert.equal(branchOfHead('ref: refs/heads/main\n'), 'main')
  assert.equal(branchOfHead('garbage'), undefined)
})

test('the folder worked on: the newest touched checkout of the same project, else the session\'s folder', async (t) => {
  const r = repo(t)
  const sib = join(r.root, 'wt-sib')
  git(r.main, 'worktree', 'add', '-q', '-b', 'sib', sib)
  const other = join(r.root, 'other')
  execFileSync('git', ['init', '-q', other])
  const home = r.root
  const inputs = [{ command: `cat ${join(sib, 'a.txt')}` }, { file_path: join(other, 'x.ts') }]
  assert.equal(await workdirOf(fs, r.main, candidatesOf(inputs, home, [])), sib, 'another project is skipped, the sibling worktree taken')
  assert.equal(await workdirOf(fs, r.main, []), r.main)
  assert.equal(await workdirOf(fs, home, candidatesOf(inputs, home, [])), other, 'outside a repository any project counts')
})

test('candidates: newest first, cut at node_modules, ignored prefixes dropped, six at most', () => {
  const home = '/Users/u'
  const inputs = [
    { command: 'ls /Users/u/p/a /Users/u/p/b' },
    { file_path: '/Users/u/p/c/node_modules/x/index.js' },
    { command: 'node /Users/u/dotfiles/claude/bin/x.ts && cat /Users/u/.claude-home/x' },
  ]
  assert.deepEqual(candidatesOf(inputs, home, ['/Users/u/.claude', '/Users/u/dotfiles']), ['/Users/u/p/c', '/Users/u/p/b', '/Users/u/p/a'])
  const many = Array.from({ length: 9 }, (_, i) => ({ file_path: `/Users/u/p/${i}` }))
  assert.equal(candidatesOf(many, home, []).length, 6)
})

test('the refresher counts changed files (untracked too) and unpushed commits', (t) => {
  const r = repo(t)
  const gitDir = join(r.main, '.git')
  const file = join(r.cache, 'git', cacheKey(gitDir))
  writeFileSync(join(r.main, 'a.txt'), 'changed\n')
  writeFileSync(join(r.main, 'new.txt'), 'new\n')
  git(r.main, 'commit', '-qam', 'two')
  writeFileSync(join(r.main, 'a.txt'), 'changed again\n')
  assert.equal(refreshCounts(r.main, gitDir, file), true)
  const c = parseCounts(readFileSync(file, 'utf8'))
  assert.equal(c.tracked, 1)
  assert.equal(c.untracked, 1)
  assert.equal(dirtyOf(c), 2)
  assert.equal(c.ahead, 1)
  assert.equal(refreshCounts(r.main, gitDir, file), false, 'fresh counts: no pass is due, no git runs')
})

test('no upstream: no ahead count, the changed count still there', (t) => {
  const r = repo(t)
  git(r.main, 'checkout', '-q', '--no-track', '-b', 'local')
  git(r.main, 'config', 'branch.local.merge', '')
  writeFileSync(join(r.main, 'a.txt'), 'x\n')
  const gitDir = join(r.main, '.git')
  const file = join(r.cache, 'git', cacheKey(gitDir))
  refreshCounts(r.main, gitDir, file)
  const c = parseCounts(readFileSync(file, 'utf8'))
  assert.equal(c.ahead, undefined)
  assert.equal(dirtyOf(c), 1)
})

test('a held lock means another process refreshes: this one runs nothing', (t) => {
  const r = repo(t)
  const gitDir = join(r.main, '.git')
  const file = join(r.cache, 'git', cacheKey(gitDir))
  mkdirSync(join(r.cache, 'git'), { recursive: true })
  const now = Math.floor(Date.now() / 1000)
  assert.ok(takeLock(`${file}.lock`, now))
  assert.equal(refreshCounts(r.main, gitDir, file), false)
  assert.throws(() => statSync(file), 'nothing written')
  assert.ok(takeLock(`${file}.lock`, now + 61), 'a lock past its minute is a dead refresher, taken over')
  assert.equal(takeLock(`${file}.lock`, now + 61), undefined, 'and the one who took it over holds it')
})

test('withLock waits for a held lock, and past its wait runs anyway: a stuck lock never drops the work', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lock = join(root, 'x.lock')
  assert.equal(withLock(lock, () => 1), 1)
  const token = takeLock(lock, Math.floor(Date.now() / 1000))
  assert.ok(token, 'released after the run')
  const started = Date.now()
  assert.equal(withLock(lock, () => 2, 120), 2)
  assert.ok(Date.now() - started >= 100, 'it waited first')
  assert.equal(readFileSync(join(lock, 'at'), 'utf8').includes(token!), true, 'and left the holder\'s lock alone')
})

test('a release frees only its own lock: a holder taken over while it stalled frees nothing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lock = join(root, 'x.lock')
  const slow = takeLock(lock, 1000)!
  const next = takeLock(lock, 2000)!
  assert.ok(next, 'stale, taken over')
  releaseLock(lock, slow)
  assert.equal(takeLock(lock, 2000), undefined, 'the new holder still holds it')
  releaseLock(lock, next)
  assert.ok(takeLock(lock, 2000))
})

test('a config dir is never a worked-on folder, an ignored folder only on its own boundary', () => {
  const home = '/Users/u'
  const inputs = [
    { file_path: '/Users/u/.claude-work2/x' },
    { file_path: '/Users/u/.claude/y' },
    { file_path: '/Users/u/.claude.json' },
    { file_path: '/Users/u/.claudette/z' },
    { file_path: '/Users/u/tmpfoo/a' },
    { file_path: '/Users/u/tmp/b' },
  ]
  assert.deepEqual(candidatesOf(inputs, home, ['/Users/u/tmp']), ['/Users/u/tmpfoo/a', '/Users/u/.claudette/z'])
})

test('of two takers that both saw a lock stale, the second finds the first one\'s fresh lock and leaves it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lock = join(root, 'x.lock')
  assert.ok(takeLock(lock, 1000))
  assert.ok(takeLock(lock, 2000), 'first taker: stale, taken over')
  assert.equal(takeLock(lock, 2000), undefined, 'second taker, same moment: the lock is fresh now')
  mkdirSync(`${lock}.takeover`)
  assert.equal(takeLock(lock, 9000), undefined, 'a takeover in progress is left to its taker')
})

test('a lock folder with no stamp yet is aged by its folder\'s time: fresh, held; old, taken over', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const now = Math.floor(Date.now() / 1000)
  const missing = join(root, 'missing.lock')
  mkdirSync(missing)
  assert.equal(takeLock(missing, now), undefined, 'no stamp file at all, just made')
  const empty = join(root, 'empty.lock')
  mkdirSync(empty)
  writeFileSync(join(empty, 'at'), '')
  assert.equal(takeLock(empty, now), undefined, 'an empty stamp, just made')
  utimesSync(missing, now - 120, now - 120)
  assert.ok(takeLock(missing, now), 'a holder that died between its mkdir and its write ages out')
})

test('which pass is due: untracked every two minutes, tracked every 20 s or when the index moved', () => {
  const now = 10_000
  assert.equal(passDue({ fastAt: 0, fullAt: 0 }, now, false), 'full')
  assert.equal(passDue({ fastAt: now - 5, fullAt: now - 5 }, now, false), undefined)
  assert.equal(passDue({ fastAt: now - 25, fullAt: now - 60 }, now, false), 'fast')
  assert.equal(passDue({ fastAt: now - 5, fullAt: now - 5 }, now, true), 'fast', 'moved, but a full pass ran under 15 s ago')
  assert.equal(passDue({ fastAt: now - 5, fullAt: now - 20 }, now, true), 'full')
  assert.equal(passDue({ fastAt: now - 5, fullAt: now - 130 }, now, false), 'full')
})
