import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Goal, Task, TaskEvent, TaskStatus, TasksState } from '../../shared/types'
import { normalizeTaskInput, tasksStateSchema, type TaskInput } from './schema'

const MAX_EVENTS = 200
const SAVE_DEBOUNCE_MS = 300

function now(): string {
  return new Date().toISOString()
}

const shortId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`

/**
 * Per-project goals & tasks, maintained by BOTH the Claude terminals (via the
 * task_* MCP tools) and the human (via IPC from the UI). Same persistence shape
 * as GraphStore: debounced atomic write to <project>/.claude-manager/tasks.json,
 * emits 'change' with the full state so every window stays in sync.
 */
export class TaskStore extends EventEmitter {
  private state: TasksState
  private filePath: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor(projectRoot: string) {
    super()
    this.filePath = join(projectRoot, '.claude-manager', 'tasks.json')
    this.state = this.load(projectRoot)
  }

  private load(projectRoot: string): TasksState {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
        const parsed = tasksStateSchema.parse(raw)
        parsed.projectRoot = projectRoot
        return parsed as TasksState
      } catch (err) {
        console.error(`Failed to load ${this.filePath}, starting fresh:`, err)
      }
    }
    return { version: 1, projectRoot, updatedAt: now(), goals: [], events: [] }
  }

  get(): TasksState {
    return this.state
  }

  addGoal(
    input: { title: string; note?: string; tasks?: TaskInput[] },
    termId: string | null
  ): { goalId: string; taskIds: string[] } {
    const ts = now()
    const goal: Goal = {
      id: shortId('g'),
      title: input.title,
      note: input.note,
      tasks: [],
      createdAt: ts,
      updatedAt: ts
    }
    const taskIds = (input.tasks ?? []).map((t) => this.pushTask(goal, t))
    this.state.goals.push(goal)
    this.commit(
      { ts, termId, tool: 'add_goal', summary: `goal "${input.title}"${taskIds.length ? ` (+${taskIds.length} task)` : ''}` },
      goal
    )
    return { goalId: goal.id, taskIds }
  }

  updateGoal(
    goalId: string,
    patch: { title?: string; note?: string },
    termId: string | null
  ): { ok: boolean; error?: string } {
    const goal = this.state.goals.find((g) => g.id === goalId)
    if (!goal) return { ok: false, error: `No goal with id "${goalId}"` }
    if (patch.title !== undefined) goal.title = patch.title
    if (patch.note !== undefined) goal.note = patch.note || undefined
    this.commit({ ts: now(), termId, tool: 'update_goal', summary: `goal "${goal.title}" edited` }, goal)
    return { ok: true }
  }

  addTasks(goalId: string, inputs: TaskInput[], termId: string | null): { taskIds: string[]; error?: string } {
    const goal = this.state.goals.find((g) => g.id === goalId)
    if (!goal) return { taskIds: [], error: `No goal with id "${goalId}"` }
    const taskIds = inputs.map((t) => this.pushTask(goal, t))
    this.commit({ ts: now(), termId, tool: 'add_tasks', summary: `+${taskIds.length} task under "${goal.title}"` }, goal)
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
    if (patch.title !== undefined) task.title = patch.title
    if (patch.status !== undefined) task.status = patch.status
    if (patch.note !== undefined) task.note = patch.note || undefined
    task.updatedAt = now()
    const label = patch.status ? `→ ${patch.status}` : 'edited'
    this.commit({ ts: task.updatedAt, termId, tool: 'update_task', summary: `"${task.title}" ${label}` }, found.goal)
    return { ok: true }
  }

  /** Removes goals and/or tasks by id (a goal id removes the goal and its tasks). */
  remove(ids: string[], termId: string | null): { removed: number } {
    const idSet = new Set(ids)
    let removed = 0
    this.state.goals = this.state.goals.filter((g) => {
      if (idSet.has(g.id)) {
        removed += 1
        return false
      }
      const before = g.tasks.length
      g.tasks = g.tasks.filter((t) => !idSet.has(t.id))
      removed += before - g.tasks.length
      if (before !== g.tasks.length) g.updatedAt = now()
      return true
    })
    this.commit({ ts: now(), termId, tool: 'remove', summary: `removed ${removed} item(s)` })
    return { removed }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
    this.removeAllListeners()
  }

  private pushTask(goal: Goal, input: TaskInput): string {
    const { title, note } = normalizeTaskInput(input)
    const ts = now()
    const task: Task = { id: shortId('t'), title, status: 'todo', note, createdAt: ts, updatedAt: ts }
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

  private commit(event: TaskEvent, touchedGoal?: Goal): void {
    if (touchedGoal) touchedGoal.updatedAt = event.ts
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
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('Failed to save tasks.json:', err)
    }
  }
}
