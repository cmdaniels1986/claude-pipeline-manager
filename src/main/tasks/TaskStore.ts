import { watch, type FSWatcher } from 'chokidar'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { Goal, GoalStatus, Task, TaskEvent, TaskStatus, TasksState, TaskTombstone } from '../../shared/types'
import { mergeTasksState } from './merge'
import { normalizeTaskInput, tasksStateSchema, type TaskInput } from './schema'

const MAX_EVENTS = 200
const MAX_TOMBSTONES = 500
const SAVE_DEBOUNCE_MS = 300
const RELOAD_DEBOUNCE_MS = 120

function now(): string {
  return new Date().toISOString()
}

const shortId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`

export interface TaskStoreOptions {
  /** absolute path to tasks.json; defaults to <projectRoot>/.claude-manager/tasks.json */
  filePath?: string
  /** display name stamped on this machine's edits (a coworker's name) */
  author?: string
  /** true when the file lives in a cloud-synced folder shared with a coworker —
   *  enables live file-watching + merge + conflict-copy detection */
  shared?: boolean
}

/**
 * Per-project goals & tasks, maintained by BOTH the Claude terminals (via the
 * task_* MCP tools) and the human (via IPC from the UI). Debounced atomic write
 * to tasks.json; emits 'change' with the full state so every window stays in sync.
 *
 * When `shared`, the file lives in a cloud-synced folder shared with a coworker.
 * We then watch the file: a coworker's edit that syncs in is merged into our
 * in-memory state (see merge.ts) and broadcast live, and every save is a
 * read-merge-write so we never clobber their concurrent edits.
 */
export class TaskStore extends EventEmitter {
  private state: TasksState
  private projectRoot: string
  private filePath: string
  private author: string
  private shared: boolean
  private saveTimer: NodeJS.Timeout | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private fileWatcher: FSWatcher | null = null
  private dirWatcher: FSWatcher | null = null
  /** exact content we last wrote, so our own writes don't trigger a reload */
  private lastWritten = ''

  constructor(projectRoot: string, opts: TaskStoreOptions = {}) {
    super()
    this.projectRoot = projectRoot
    this.filePath = opts.filePath ?? join(projectRoot, '.claude-manager', 'tasks.json')
    this.author = opts.author?.trim() || 'me'
    this.shared = !!opts.shared
    this.state = this.load()
    if (this.shared) this.startWatching()
  }

  /** Read a tasks.json off disk without constructing a live store (used to grab
   *  a project's current tasks for migration). Returns an empty state if absent. */
  static readFile(filePath: string, projectRoot: string): TasksState {
    if (existsSync(filePath)) {
      try {
        const parsed = tasksStateSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
        parsed.projectRoot = projectRoot
        return parsed as TasksState
      } catch (err) {
        console.error(`Failed to read ${filePath} for migration:`, err)
      }
    }
    return { version: 1, projectRoot, updatedAt: now(), goals: [], events: [], removed: [] }
  }

  private load(): TasksState {
    const disk = this.readDisk()
    if (disk) return disk
    return { version: 1, projectRoot: this.projectRoot, updatedAt: now(), goals: [], events: [], removed: [] }
  }

  /** Parse the file from disk, or null if missing / unreadable / mid-write. */
  private readDisk(): TasksState | null {
    if (!existsSync(this.filePath)) return null
    try {
      const parsed = tasksStateSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')))
      parsed.projectRoot = this.projectRoot
      return parsed as TasksState
    } catch (err) {
      // a partial write during cloud sync will fail to parse — skip this read
      console.error(`Failed to read ${this.filePath}:`, err)
      return null
    }
  }

  get(): TasksState {
    return this.state
  }

  isShared(): boolean {
    return this.shared
  }

  private who(termId: string | null): string {
    return termId ? 'agent' : this.author
  }

  addGoal(
    input: { title: string; note?: string; tasks?: TaskInput[] },
    termId: string | null
  ): { goalId: string; taskIds: string[] } {
    const ts = now()
    const by = this.who(termId)
    const goal: Goal = {
      id: shortId('g'),
      title: input.title,
      status: 'active',
      note: input.note,
      tasks: [],
      createdAt: ts,
      updatedAt: ts,
      updatedBy: by
    }
    const taskIds = (input.tasks ?? []).map((t) => this.pushTask(goal, t, by))
    this.state.goals.push(goal)
    this.commit(
      { ts, termId, by, tool: 'add_goal', summary: `goal "${input.title}"${taskIds.length ? ` (+${taskIds.length} task)` : ''}` },
      goal
    )
    return { goalId: goal.id, taskIds }
  }

  updateGoal(
    goalId: string,
    patch: { title?: string; note?: string; status?: GoalStatus },
    termId: string | null
  ): { ok: boolean; error?: string } {
    const goal = this.state.goals.find((g) => g.id === goalId)
    if (!goal) return { ok: false, error: `No goal with id "${goalId}"` }
    if (patch.title !== undefined) goal.title = patch.title
    if (patch.note !== undefined) goal.note = patch.note || undefined
    if (patch.status !== undefined) goal.status = patch.status
    const summary =
      patch.status !== undefined
        ? `goal "${goal.title}" ${patch.status === 'done' ? 'completed ✓' : 'reopened'}`
        : `goal "${goal.title}" edited`
    this.commit({ ts: now(), termId, by: this.who(termId), tool: 'update_goal', summary }, goal)
    return { ok: true }
  }

  addTasks(goalId: string, inputs: TaskInput[], termId: string | null): { taskIds: string[]; error?: string } {
    const goal = this.state.goals.find((g) => g.id === goalId)
    if (!goal) return { taskIds: [], error: `No goal with id "${goalId}"` }
    const by = this.who(termId)
    const taskIds = inputs.map((t) => this.pushTask(goal, t, by))
    this.commit({ ts: now(), termId, by, tool: 'add_tasks', summary: `+${taskIds.length} task under "${goal.title}"` }, goal)
    return { taskIds }
  }

  updateTask(
    taskId: string,
    patch: { title?: string; status?: TaskStatus; note?: string },
    termId: string | null
  ): { ok: boolean; error?: string } {
    const found = this.findTask(taskId)
    if (!found) return { ok: false, error: `No task with id "${taskId}"` }
    const { task } = found
    const by = this.who(termId)
    if (patch.title !== undefined) task.title = patch.title
    if (patch.status !== undefined) task.status = patch.status
    if (patch.note !== undefined) task.note = patch.note || undefined
    task.updatedAt = now()
    task.updatedBy = by
    const label = patch.status ? `→ ${patch.status}` : 'edited'
    this.commit({ ts: task.updatedAt, termId, by, tool: 'update_task', summary: `"${task.title}" ${label}` }, found.goal)
    return { ok: true }
  }

  /** Removes goals and/or tasks by id (a goal id removes the goal and its tasks),
   *  recording tombstones so the deletion propagates across a shared file. */
  remove(ids: string[], termId: string | null): { removed: number } {
    const idSet = new Set(ids)
    const ts = now()
    const tombstoned: string[] = []
    let removed = 0
    this.state.goals = this.state.goals.filter((g) => {
      if (idSet.has(g.id)) {
        removed += 1
        tombstoned.push(g.id)
        g.tasks.forEach((t) => tombstoned.push(t.id)) // tombstone the goal's tasks too
        return false
      }
      const before = g.tasks.length
      g.tasks = g.tasks.filter((t) => {
        if (idSet.has(t.id)) {
          tombstoned.push(t.id)
          return false
        }
        return true
      })
      removed += before - g.tasks.length
      if (before !== g.tasks.length) g.updatedAt = ts
      return true
    })
    this.addTombstones(tombstoned, ts)
    this.commit({ ts, termId, by: this.who(termId), tool: 'remove', summary: `removed ${removed} item(s)` })
    return { removed }
  }

  /** Insert a whole goal (with its tasks), re-stamping timestamps so it wins
   *  merges in its new home. Used to move a goal between the local & shared
   *  lists. Preserves ids so references stay stable. */
  insertGoal(goal: Goal, termId: string | null): void {
    const ts = now()
    const by = this.who(termId)
    const cloned: Goal = {
      ...goal,
      updatedAt: ts,
      updatedBy: by,
      tasks: goal.tasks.map((t) => ({ ...t, updatedAt: ts, updatedBy: by }))
    }
    this.state.goals.push(cloned)
    this.commit(
      { ts, termId, by, tool: 'move_goal', summary: `goal "${goal.title}" moved here` },
      cloned
    )
  }

  /** Migrate an existing task state into this store (used when a project is
   *  switched to/from a shared location): union the old tasks with whatever is
   *  already here, then persist + broadcast. */
  importState(prev: TasksState): void {
    const merged = mergeTasksState(prev, this.state)
    merged.projectRoot = this.projectRoot
    merged.updatedAt = now()
    this.state = merged
    this.commit({ ts: this.state.updatedAt, termId: null, by: this.author, tool: 'migrate', summary: 'migrated tasks into this list' })
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    void this.fileWatcher?.close()
    void this.dirWatcher?.close()
    this.fileWatcher = null
    this.dirWatcher = null
    this.save()
    this.removeAllListeners()
  }

  private pushTask(goal: Goal, input: TaskInput, by: string): string {
    const { title, note } = normalizeTaskInput(input)
    const ts = now()
    const task: Task = { id: shortId('t'), title, status: 'todo', note, createdAt: ts, updatedAt: ts, updatedBy: by }
    goal.tasks.push(task)
    goal.updatedAt = ts
    return task.id
  }

  private findTask(taskId: string): { goal: Goal; task: Task } | null {
    for (const goal of this.state.goals) {
      const task = goal.tasks.find((t) => t.id === taskId)
      if (task) return { goal, task }
    }
    return null
  }

  private addTombstones(ids: string[], ts: string): void {
    if (!ids.length) return
    const removed = this.state.removed ?? (this.state.removed = [])
    for (const id of ids) removed.push({ id, ts })
    if (removed.length > MAX_TOMBSTONES) removed.splice(0, removed.length - MAX_TOMBSTONES)
  }

  private commit(event: TaskEvent, touchedGoal?: Goal): void {
    if (touchedGoal) {
      touchedGoal.updatedAt = event.ts
      touchedGoal.updatedBy = event.by
    }
    this.state.events.push(event)
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS)
    }
    this.state.updatedAt = event.ts
    this.scheduleSave()
    this.emit('change', { tasks: this.state, event })
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      // fold in anything a coworker wrote since our last read, so our write is
      // additive rather than a destructive overwrite of their concurrent edits
      if (this.shared) {
        const disk = this.readDisk()
        if (disk) {
          this.state = mergeTasksState(this.state, disk)
          this.state.projectRoot = this.projectRoot
        }
      }
      const content = JSON.stringify(this.state, null, 2)
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, content)
      renameSync(tmp, this.filePath)
      this.lastWritten = content
    } catch (err) {
      console.error('Failed to save tasks.json:', err)
    }
  }

  // ---- shared-file watching ------------------------------------------------

  private startWatching(): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    this.fileWatcher = watch(this.filePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    })
    const onFsEvent = (): void => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => this.reloadFromDisk(), RELOAD_DEBOUNCE_MS)
    }
    this.fileWatcher.on('add', onFsEvent).on('change', onFsEvent)

    // detect cloud-drive "conflicted copy" siblings so the user doesn't silently
    // lose edits into a stray file
    const base = basename(this.filePath, '.json')
    this.dirWatcher = watch(dir, { ignoreInitial: true, depth: 0 })
    this.dirWatcher.on('add', (p) => {
      const name = basename(p)
      if (name !== basename(this.filePath) && name.startsWith(base) && /conflict|\(\d+\)\.json$/i.test(name)) {
        this.emit('warning', {
          projectRoot: this.projectRoot,
          message: `Cloud drive made a conflicted copy "${name}" — two people likely edited at the same time. Open the shared folder to reconcile it.`
        })
      }
    })
  }

  private reloadFromDisk(): void {
    let content: string
    try {
      content = readFileSync(this.filePath, 'utf8')
    } catch {
      return
    }
    if (content === this.lastWritten) return // our own write echoing back
    let disk: TasksState
    try {
      disk = tasksStateSchema.parse(JSON.parse(content)) as TasksState
    } catch {
      return // mid-sync partial write; the next event will have the whole file
    }
    disk.projectRoot = this.projectRoot
    const before = this.comparable(this.state)
    const merged = mergeTasksState(this.state, disk)
    merged.projectRoot = this.projectRoot
    if (this.comparable(merged) === before) return // nothing new for us
    this.state = merged
    this.state.updatedAt = now()
    this.emit('change', { tasks: this.state, event: null })
    // if we hold items the coworker's copy is missing, flush them back so they converge
    if (this.comparable(merged) !== this.comparable(disk)) this.scheduleSave()
  }

  /** stable projection for change detection (ignores volatile top-level fields) */
  private comparable(s: TasksState): string {
    return JSON.stringify({ goals: s.goals, events: s.events, removed: s.removed ?? [] })
  }
}
