import { execFileSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { ChangedNodesResult, GraphNode } from '../../shared/types'

/** normalize a path for cross-platform comparison (forward slashes, lowercased) */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** true when `changed` (a repo-relative-or-absolute changed file) refers to the
 *  same file as node path `nodePath`. Absolute → exact; relative node path →
 *  segment-aware suffix match so "models/stg_orders.sql" matches its absolute form. */
function pathsMatch(nodePath: string, changedAbs: string): boolean {
  const a = norm(nodePath)
  const b = norm(changedAbs)
  if (a === b) return true
  if (isAbsolute(nodePath)) return false
  // relative: match if the changed absolute path ends on the node's path segments
  return b === a || b.endsWith('/' + a)
}

/** Pure: given node source paths and the set of changed absolute file paths,
 *  return the ids of nodes whose file changed. Exported for unit testing. */
export function matchChangedNodes(
  nodes: { id: string; path: string }[],
  changedAbs: string[]
): string[] {
  const changed = changedAbs.map(norm)
  const hits: string[] = []
  for (const n of nodes) {
    if (changed.some((c) => pathsMatch(n.path, c))) hits.push(n.id)
  }
  return hits
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** walk up from a file/dir to the nearest ancestor containing a .git entry */
function findGitRoot(startAbs: string): string | null {
  // begin at the folder itself if it's a dir, otherwise its parent
  let dir = isDir(startAbs) ? startAbs : dirname(startAbs)
  let prev = ''
  while (dir && dir !== prev) {
    if (existsSync(join(dir, '.git'))) return dir
    prev = dir
    dir = dirname(dir)
  }
  return null
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  })
}

/** Files changed in a repo vs HEAD (staged + unstaged + untracked), as absolute paths. */
function changedFilesIn(root: string): string[] {
  const out = new Set<string>()
  try {
    // porcelain: XY <path> (renames as "old -> new"); -uall lists every untracked file
    const status = git(root, ['status', '--porcelain', '-uall'])
    for (const line of status.split('\n')) {
      if (!line.trim()) continue
      let file = line.slice(3).trim()
      const arrow = file.indexOf(' -> ')
      if (arrow !== -1) file = file.slice(arrow + 4)
      file = file.replace(/^"|"$/g, '')
      out.add(resolve(root, file))
    }
  } catch {
    // not a repo / git missing — caller handles the empty result
  }
  return [...out]
}

function currentBranch(root: string): string | null {
  try {
    const b = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    return b || null
  } catch {
    return null
  }
}

/** Scope the graph to files changed in git: for each node with a source file,
 *  find its repo, diff it, and report which nodes are touched. Best-effort and
 *  fully local (no network, no tokens). */
export function computeChangedNodes(nodes: GraphNode[]): ChangedNodesResult {
  const withPath = nodes
    .map((n) => ({ id: n.id, path: n.meta.path }))
    .filter((n): n is { id: string; path: string } => !!n.path)

  if (!withPath.length) {
    return { changed: [], branch: null, repos: 0, reason: 'No nodes have a source file recorded.' }
  }

  // find repos from absolute paths; cache changed-file scans per repo
  const repoRoots = new Set<string>()
  for (const n of withPath) {
    if (isAbsolute(n.path)) {
      const root = findGitRoot(resolve(n.path))
      if (root) repoRoots.add(root)
    }
  }

  if (!repoRoots.size) {
    return {
      changed: [],
      branch: null,
      repos: 0,
      reason:
        'Could not locate a git repo from the node source files (their paths may be relative or outside a repo).'
    }
  }

  const changedAbs: string[] = []
  let branch: string | null = null
  for (const root of repoRoots) {
    changedAbs.push(...changedFilesIn(root))
    branch ??= currentBranch(root)
  }

  return {
    changed: matchChangedNodes(withPath, changedAbs),
    branch,
    repos: repoRoots.size
  }
}
