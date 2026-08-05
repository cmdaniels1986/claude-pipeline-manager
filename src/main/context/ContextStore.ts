import { watch, type FSWatcher } from 'chokidar'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ContextPost, ContextState } from '../../shared/types'

const MAX_POSTS = 300
const MAX_TOMBSTONES = 500
const SAVE_DEBOUNCE_MS = 300
const RELOAD_DEBOUNCE_MS = 120

function now(): string {
  return new Date().toISOString()
}

/**
 * Union two context states: keep every post by id (newer ts wins on the rare
 * duplicate), drop any post with a tombstone at/after its own timestamp so a
 * delete propagates, and sort oldest→newest. Same last-write-wins philosophy as
 * the tasks merge, so two coworkers posting through a cloud-synced folder never
 * clobber each other.
 */
export function mergeContext(base: ContextState, incoming: ContextState): ContextState {
  const tomb = new Map<string, string>()
  for (const t of [...(base.removed ?? []), ...(incoming.removed ?? [])]) {
    const cur = tomb.get(t.id)
    if (!cur || t.ts > cur) tomb.set(t.id, t.ts)
  }
  const byId = new Map<string, ContextPost>()
  for (const p of [...base.posts, ...incoming.posts]) {
    const cur = byId.get(p.id)
    if (!cur || p.ts > cur.ts) byId.set(p.id, p)
  }
  const posts = [...byId.values()]
    .filter((p) => {
      const dead = tomb.get(p.id)
      return !(dead != null && dead >= p.ts)
    })
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .slice(-MAX_POSTS)
  const removed = [...tomb.entries()]
    .map(([id, ts]) => ({ id, ts }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, MAX_TOMBSTONES)
  return {
    version: 1,
    updatedAt: base.updatedAt > incoming.updatedAt ? base.updatedAt : incoming.updatedAt,
    posts,
    removed
  }
}

/**
 * The project's shared context: coworker-posted notes that live in the same
 * cloud-synced folder as the shared tasks (`<sharedFolder>/context.json`), plus
 * a human-readable `CONTEXT.md` rendered alongside so anyone browsing the folder
 * can read it without the app. Only exists when the project has a shared folder.
 * Watches the file so a coworker's post syncs in live, and every save is a
 * read-merge-write so concurrent posts don't clobber each other.
 */
export class ContextStore extends EventEmitter {
  private state: ContextState
  private filePath: string
  private mdPath: string
  private author: string
  private saveTimer: NodeJS.Timeout | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private watcher: FSWatcher | null = null
  private lastWritten = ''

  constructor(sharedFolder: string, author: string) {
    super()
    this.filePath = join(sharedFolder, 'context.json')
    this.mdPath = join(sharedFolder, 'CONTEXT.md')
    this.author = author?.trim() || 'me'
    this.state = this.readDisk() ?? { version: 1, updatedAt: now(), posts: [], removed: [] }
    this.startWatching()
  }

  get(): ContextPost[] {
    return this.state.posts
  }

  /** Add a context note (from the composer or the "working on it" prompt). */
  post(input: { text: string; taskId?: string; taskTitle?: string }): ContextPost {
    const entry: ContextPost = {
      id: `c-${randomUUID().slice(0, 8)}`,
      author: this.author,
      ts: now(),
      text: input.text.trim(),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.taskTitle ? { taskTitle: input.taskTitle } : {})
    }
    this.state.posts.push(entry)
    if (this.state.posts.length > MAX_POSTS) this.state.posts.splice(0, this.state.posts.length - MAX_POSTS)
    this.touch()
    return entry
  }

  remove(id: string): void {
    const before = this.state.posts.length
    this.state.posts = this.state.posts.filter((p) => p.id !== id)
    if (this.state.posts.length === before) return
    const removed = this.state.removed ?? (this.state.removed = [])
    removed.push({ id, ts: now() })
    if (removed.length > MAX_TOMBSTONES) removed.splice(0, removed.length - MAX_TOMBSTONES)
    this.touch()
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    void this.watcher?.close()
    this.watcher = null
    this.save()
    this.removeAllListeners()
  }

  private touch(): void {
    this.state.updatedAt = now()
    this.scheduleSave()
    this.emit('change', this.state.posts)
  }

  private readDisk(): ContextState | null {
    if (!existsSync(this.filePath)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as ContextState
      if (parsed && parsed.version === 1 && Array.isArray(parsed.posts)) return parsed
      return null
    } catch {
      return null // partial write mid-sync; a later event has the whole file
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      // fold in anything a coworker wrote since our last read so we don't clobber it
      const disk = this.readDisk()
      if (disk) this.state = mergeContext(this.state, disk)
      const content = JSON.stringify(this.state, null, 2)
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, content)
      renameSync(tmp, this.filePath)
      this.lastWritten = content
      this.renderMarkdown()
    } catch (err) {
      console.error('Failed to save context.json:', err)
    }
  }

  /** Human-readable mirror so the shared folder has a real, readable context file. */
  private renderMarkdown(): void {
    try {
      const lines = ['# Shared context', '', '_Notes coworkers posted about this project. Maintained by Claude Pipeline Manager._', '']
      for (const p of [...this.state.posts].reverse()) {
        const when = p.ts.replace('T', ' ').slice(0, 16)
        const about = p.taskTitle ? ` · on “${p.taskTitle}”` : ''
        lines.push(`## ${p.author} — ${when}${about}`, '', p.text, '')
      }
      writeFileSync(this.mdPath, lines.join('\n'))
    } catch {
      // best-effort mirror; the JSON is the source of truth
    }
  }

  private startWatching(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    this.watcher = watch(this.filePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    })
    const onEvent = (): void => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => this.reloadFromDisk(), RELOAD_DEBOUNCE_MS)
    }
    this.watcher.on('add', onEvent).on('change', onEvent)
  }

  private reloadFromDisk(): void {
    let content: string
    try {
      content = readFileSync(this.filePath, 'utf8')
    } catch {
      return
    }
    if (content === this.lastWritten) return // our own echo
    const disk = this.readDisk()
    if (!disk) return
    const before = JSON.stringify(this.state.posts)
    const merged = mergeContext(this.state, disk)
    if (JSON.stringify(merged.posts) === before) return
    this.state = merged
    this.emit('change', this.state.posts)
    // if we hold posts the coworker's copy lacks, flush so they converge
    if (JSON.stringify(merged.posts) !== JSON.stringify(disk.posts)) this.scheduleSave()
  }
}
