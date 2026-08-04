import { join } from 'path'
import type {
  Goal,
  GoalStatus,
  TaskEvent,
  TaskScope,
  TasksChangedPayload,
  TasksSnapshot,
  TasksState,
  TaskStatus,
  TasksWarning
} from '../../shared/types'
import { TaskStore } from './TaskStore'
import type { TaskInput } from './schema'

export interface TaskHubOptions {
  projectRoot: string
  /** folder holding the shared tasks.json, or null for a private-only project */
  sharedPath: string | null
  author: string
  onChange: (payload: TasksChangedPayload) => void
  onWarning: (w: TasksWarning) => void
}

/**
 * A project's two task lists behind one façade: a local "My Goals" store
 * (private to this machine) and, when a shared folder is configured, a synced
 * "Shared Goals" store. Edits from the UI and the MCP tools address goals/tasks
 * by id — the hub routes each to whichever list holds it — while goals can be
 * moved between the two. Both lists surface together in one board.
 */
export class TaskHub {
  private local: TaskStore
  private shared: TaskStore | null = null
  private projectRoot: string
  private author: string
  private sharedPath: string | null
  private onChange: (p: TasksChangedPayload) => void
  private onWarning: (w: TasksWarning) => void

  constructor(opts: TaskHubOptions) {
    this.projectRoot = opts.projectRoot
    this.author = opts.author
    this.sharedPath = opts.sharedPath
    this.onChange = opts.onChange
    this.onWarning = opts.onWarning
    this.local = this.makeStore(false)
    if (this.sharedPath) this.shared = this.makeStore(true)
  }

  private makeStore(shared: boolean): TaskStore {
    const store = new TaskStore(this.projectRoot, {
      filePath: shared ? join(this.sharedPath as string, 'tasks.json') : undefined,
      author: this.author,
      shared
    })
    const scope: TaskScope = shared ? 'shared' : 'mine'
    store.on('change', (p: { tasks: TasksState; event: TaskEvent | null }) => this.emit(scope, p.event))
    store.on('warning', (w: TasksWarning) => this.onWarning(w))
    return store
  }

  private emit(scope: TaskScope | null, event: TaskEvent | null): void {
    this.onChange({ ...this.snapshot(), event, scope })
  }

  snapshot(): TasksSnapshot {
    return {
      mine: this.local.get(),
      shared: this.shared?.get() ?? null,
      sharedPath: this.sharedPath
    }
  }

  hasShared(): boolean {
    return this.shared != null
  }

  // ---- routing helpers -----------------------------------------------------

  private stores(): TaskStore[] {
    return this.shared ? [this.local, this.shared] : [this.local]
  }

  private storeForGoal(goalId: string): TaskStore | null {
    return this.stores().find((s) => s.get().goals.some((g) => g.id === goalId)) ?? null
  }

  private storeForTask(taskId: string): TaskStore | null {
    return this.stores().find((s) => s.get().goals.some((g) => g.tasks.some((t) => t.id === taskId))) ?? null
  }

  private ownsId(store: TaskStore, id: string): boolean {
    return store.get().goals.some((g) => g.id === id || g.tasks.some((t) => t.id === id))
  }

  // ---- mutations (mirror TaskStore's API, used by IPC + MCP) ---------------

  addGoal(
    input: { title: string; note?: string; tasks?: TaskInput[] },
    termId: string | null,
    scope: TaskScope = 'mine'
  ): { goalId: string; taskIds: string[] } {
    const store = scope === 'shared' && this.shared ? this.shared : this.local
    return store.addGoal(input, termId)
  }

  updateGoal(
    goalId: string,
    patch: { title?: string; note?: string; status?: GoalStatus },
    termId: string | null
  ): { ok: boolean; error?: string } {
    const store = this.storeForGoal(goalId)
    if (!store) return { ok: false, error: `No goal with id "${goalId}"` }
    return store.updateGoal(goalId, patch, termId)
  }

  /** Set status for an id that may be a task OR a goal (used by the MCP
   *  tasks_set_status tool so agents can mark a whole goal complete). A goal
   *  maps 'done' → completed and anything else → active. */
  setStatus(
    id: string,
    status: TaskStatus,
    termId: string | null
  ): { ok: boolean; error?: string; kind?: 'task' | 'goal' } {
    if (this.storeForTask(id)) return { ...this.updateTask(id, { status }, termId), kind: 'task' }
    if (this.storeForGoal(id)) {
      return { ...this.updateGoal(id, { status: status === 'done' ? 'done' : 'active' }, termId), kind: 'goal' }
    }
    return { ok: false, error: `No goal or task with id "${id}"` }
  }

  addTasks(goalId: string, inputs: TaskInput[], termId: string | null): { taskIds: string[]; error?: string } {
    const store = this.storeForGoal(goalId)
    if (!store) return { taskIds: [], error: `No goal with id "${goalId}"` }
    return store.addTasks(goalId, inputs, termId)
  }

  updateTask(
    taskId: string,
    patch: { title?: string; status?: TaskStatus; note?: string },
    termId: string | null
  ): { ok: boolean; error?: string } {
    const store = this.storeForTask(taskId)
    if (!store) return { ok: false, error: `No task with id "${taskId}"` }
    return store.updateTask(taskId, patch, termId)
  }

  remove(ids: string[], termId: string | null): { removed: number } {
    let removed = 0
    for (const store of this.stores()) {
      const mine = ids.filter((id) => this.ownsId(store, id))
      if (mine.length) removed += store.remove(mine, termId).removed
    }
    return { removed }
  }

  /** Move a goal (with its tasks) between the private and shared lists. */
  moveGoal(goalId: string, toScope: TaskScope, termId: string | null): { ok: boolean; error?: string } {
    const from = this.storeForGoal(goalId)
    if (!from) return { ok: false, error: `No goal with id "${goalId}"` }
    if (toScope === 'shared' && !this.shared) {
      return { ok: false, error: 'This project has no shared folder — set one up first.' }
    }
    const dest = toScope === 'shared' ? (this.shared as TaskStore) : this.local
    if (from === dest) return { ok: true }
    const goal = from.get().goals.find((g) => g.id === goalId) as Goal
    dest.insertGoal(structuredClone(goal), termId)
    from.remove([goalId], termId)
    return { ok: true }
  }

  /** Turn a shared list on/off (or point it at a different folder). Disabling
   *  copies the shared goals back into the private list so nothing is lost here;
   *  the file in the shared folder is left in place for the coworker. */
  setSharedPath(path: string | null): void {
    const next = path || null
    if (next === this.sharedPath) return
    if (!next) {
      if (this.shared) {
        for (const g of this.shared.get().goals) this.local.insertGoal(structuredClone(g), null)
        this.shared.dispose()
        this.shared = null
      }
      this.sharedPath = null
    } else {
      this.shared?.dispose()
      this.sharedPath = next
      this.shared = this.makeStore(true)
    }
    this.emit(null, null)
  }

  dispose(): void {
    this.local.dispose()
    this.shared?.dispose()
    this.shared = null
  }
}
