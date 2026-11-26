/**
 * The branch and its marks without running git on the drawing path. What the
 * line needs of a checkout is in files git keeps (`.git`, HEAD, `commondir`,
 * the origin URL); the changed and unpushed counts come from a cache shared by
 * every session of every profile, refreshed in the background by one process
 * per checkout (bin/statusline.ts `git`), fast for tracked files and slower for
 * untracked ones, which cost a walk of the whole tree.
 */

/** What the line reads of the file system: `$.fs` in the mod, node:fs in tests and the CLI. */
export interface FsLike {
  read(path: string): Promise<string>
  stat(path: string): Promise<{ kind: string; mtimeMs: number }>
}

export interface GitFacts {
  /** The checkout's root. */
  top: string
  /** Its own git dir: HEAD and the index live here. */
  gitDir: string
  /** The shared one: config and refs. */
  common: string
  /** The project: origin's URL, so clones and worktrees of one project match; the common dir without a remote. */
  id: string
}

/** Tracked and ahead every this many seconds, and at once when the index or HEAD moved. */
export const GIT_FAST_TTL = 20
/** Untracked every this many seconds, or this soon after the index or HEAD moved. */
export const GIT_FULL_TTL = 120
export const GIT_FULL_MIN = 15

const isDir = async (fs: FsLike, p: string) => (await fs.stat(p).catch(() => undefined))?.kind === 'dir'
const isFile = async (fs: FsLike, p: string) => (await fs.stat(p).catch(() => undefined))?.kind === 'file'
const firstLine = async (fs: FsLike, p: string) => (await fs.read(p).catch(() => '')).split('\n')[0]!.trim()

export function originUrl(config: string): string | undefined {
  let inOrigin = false
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]/.test(line)
      continue
    }
    const m = inOrigin ? /^url\s*=\s*(.*\S)\s*$/.exec(line) : null
    if (m) return m[1]
  }
  return undefined
}

/** The checkout holding `dir`, or undefined outside one. */
export async function gitFactsOf(fs: FsLike, dir: string): Promise<GitFacts | undefined> {
  let p = dir.replace(/\/+$/, '')
  let gitDir: string | undefined
  while (p !== '') {
    if (await isDir(fs, `${p}/.git`)) {
      gitDir = `${p}/.git`
      break
    }
    if (await isFile(fs, `${p}/.git`)) {
      const line = await firstLine(fs, `${p}/.git`)
      if (!line.startsWith('gitdir: ')) return undefined
      gitDir = line.slice('gitdir: '.length)
      if (!gitDir.startsWith('/')) gitDir = `${p}/${gitDir}`
      break
    }
    if (!p.includes('/')) return undefined
    p = p.slice(0, p.lastIndexOf('/'))
  }
  if (gitDir === undefined || !(await isFile(fs, `${gitDir}/HEAD`))) return undefined
  let common = gitDir
  const rel = await firstLine(fs, `${gitDir}/commondir`)
  if (rel !== '') common = rel.startsWith('/') ? rel : `${gitDir}/${rel}`
  // git writes `<main>/.git/worktrees/<x>/../..`: a worktree and its main checkout name one common dir.
  common = common.replace(/\/worktrees\/[^/]+\/\.\.\/\.\.$/, '')
  const url = originUrl(await fs.read(`${common}/config`).catch(() => ''))
  return { top: p === '' ? '/' : p, gitDir, common, id: url ?? common }
}

/** HEAD's branch, or `@<7 hex>` when detached; the short sha is a fixed seven, not git's abbreviation. */
export function branchOfHead(head: string): string | undefined {
  const line = head.split('\n')[0]!.trim()
  if (line.startsWith('ref: refs/heads/')) return line.slice('ref: refs/heads/'.length)
  return /^[0-9a-f]{40,64}$/.test(line) ? `@${line.slice(0, 7)}` : undefined
}

/** One flat cache file name per git dir, no hashing. */
export function cacheKey(gitDir: string): string {
  return gitDir.replaceAll('/', '%')
}

export interface GitCounts {
  /** When tracked and ahead were last counted, epoch seconds; 0 never. */
  fastAt: number
  tracked?: number
  ahead?: number
  /** When untracked was last counted. */
  fullAt: number
  untracked?: number
}

const count = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined)

/** `<fast epoch>\t<tracked>\t<ahead>\t<full epoch>\t<untracked>`, `-` for unknown. */
export function parseCounts(text: string): GitCounts {
  const [ef, trk, ah, eu, unt] = text.trim().split('\t')
  return { fastAt: count(ef) ?? 0, tracked: count(trk), ahead: count(ah), fullAt: count(eu) ?? 0, untracked: count(unt) }
}

export function countsText(c: GitCounts): string {
  const s = (v: number | undefined) => (v === undefined ? '-' : String(v))
  return `${c.fastAt}\t${s(c.tracked)}\t${s(c.ahead)}\t${c.fullAt}\t${s(c.untracked)}\n`
}

/** Which pass is due: `moved` when the index or HEAD is newer than the cache. */
export function passDue(c: GitCounts, nowSec: number, moved: boolean): 'full' | 'fast' | undefined {
  if (nowSec - c.fullAt >= GIT_FULL_TTL) return 'full'
  // add and commit move files between untracked and tracked, but any foreign `git status` rewrites the index too.
  if (moved && nowSec - c.fullAt >= GIT_FULL_MIN) return 'full'
  if (moved || nowSec - c.fastAt >= GIT_FAST_TTL) return 'fast'
  return undefined
}

/** Changed files, untracked among them; undefined before the first count. */
export function dirtyOf(c: GitCounts): number | undefined {
  return c.tracked === undefined ? undefined : c.tracked + (c.untracked ?? 0)
}

const PATH_CHARS = /[A-Za-z0-9._@/-]+/

/**
 * Folders the recent tool calls touched, newest first, at most six: absolute
 * paths under `home` from each call's input, cut before `node_modules` (a
 * worktree's links lead into the main checkout), none under an `ignore`
 * folder, and none in a config dir (`~/.claude`, `~/.claude-work2`, ...).
 */
export function candidatesOf(inputs: readonly unknown[], home: string, ignore: readonly string[]): string[] {
  const configDirs = `${home}/.claude`
  const ignored = (p: string) => p.startsWith(configDirs) || ignore.some((i) => i !== '' && (p === i.replace(/\/+$/, '') || p.startsWith(i.endsWith('/') ? i : `${i}/`)))
  const re = new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${PATH_CHARS.source}`, 'g')
  const found: string[] = []
  for (const input of inputs) {
    const text = typeof input === 'string' ? input : JSON.stringify(input) ?? ''
    for (const m of text.matchAll(re)) found.push(m[0].replace(/\/node_modules(\/.*)?$/, ''))
  }
  const out: string[] = []
  for (const p of found.reverse()) {
    if (ignored(p)) continue
    if (!out.includes(p)) out.push(p)
    if (out.length === 6) break
  }
  return out
}

/** The checkout the session works in: the newest candidate's of the same project as `cwd` (any project, outside a repo), else `cwd`. */
export async function workdirOf(fs: FsLike, cwd: string, candidates: readonly string[]): Promise<string> {
  const anchor = await gitFactsOf(fs, cwd)
  for (let p of candidates) {
    while (p !== '' && p !== '/' && !(await isDir(fs, p))) p = p.slice(0, p.lastIndexOf('/'))
    if (p === '' || p === '/') continue
    const g = await gitFactsOf(fs, p)
    if (g === undefined || (anchor !== undefined && g.id !== anchor.id)) continue
    return g.top
  }
  return cwd
}
