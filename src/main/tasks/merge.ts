import type { Goal, Task, TaskEvent, TasksState, TaskTombstone } from '../../shared/types'

/**
 * Conflict-free-ish merge of two task states, used when a shared tasks.json is
 * edited by more than one app at once (coworker's copy syncs in via a cloud
 * drive). Strategy: union goals & tasks by id, keeping whichever copy was
 * edited most recently (ISO timestamps sort chronologically), and suppress any
 * id that has a newer tombstone so a delete propagates instead of resurrecting.
 *
 * Not a true CRDT — two people editing the *same* task at the same time still
 * resolves last-write-wins on that one field. But edits to *different* items
 * never clobber each other, which is the common case for a shared board.
 */
const MAX_EVENTS = 200
const MAX_TOMBSTONES = 500

function newer<T extends { updatedAt: string }>(a: T, b: T): T {
  return b.updatedAt > a.updatedAt ? b : a
}

function mergeTasks(a: Task[], b: Task[]): Task[] {
  const byId = new Map<string, Task>()
  for (const t of a) byId.set(t.id, t)
  for (const t of b) {
    const cur = byId.get(t.id)
    byId.set(t.id, cur ? newer(cur, t) : t)
  }
  return [...byId.values()]
}

function mergeGoals(a: Goal[], b: Goal[]): Goal[] {
  const aMap = new Map(a.map((g) => [g.id, g]))
  const bMap = new Map(b.map((g) => [g.id, g]))
  const order: string[] = a.map((g) => g.id)
  for (const g of b) if (!aMap.has(g.id)) order.push(g.id)
  return order.map((id) => {
    const ga = aMap.get(id)
    const gb = bMap.get(id)
    if (ga && gb) {
      // goal title/note/updatedAt from the newer copy; tasks are unioned
      return { ...newer(ga, gb), tasks: mergeTasks(ga.tasks, gb.tasks) }
    }
    return (ga ?? gb) as Goal
  })
}

function mergeTombstones(a: TaskTombstone[] = [], b: TaskTombstone[] = []): TaskTombstone[] {
  const byId = new Map<string, string>()
  for (const t of [...a, ...b]) {
    const cur = byId.get(t.id)
    if (!cur || t.ts > cur) byId.set(t.id, t.ts)
  }
  return [...byId.entries()]
    .map(([id, ts]) => ({ id, ts }))
    .sort((x, y) => (x.ts < y.ts ? 1 : -1)) // newest first
    .slice(0, MAX_TOMBSTONES)
}

function applyTombstones(goals: Goal[], tomb: Map<string, string>): Goal[] {
  const dead = (id: string, updatedAt: string): boolean => {
    const ts = tomb.get(id)
    return ts != null && ts >= updatedAt // deleted at/after its last edit
  }
  const alive: Goal[] = []
  for (const g of goals) {
    if (dead(g.id, g.updatedAt)) continue
    alive.push({ ...g, tasks: g.tasks.filter((t) => !dead(t.id, t.updatedAt)) })
  }
  return alive
}

function mergeEvents(a: TaskEvent[], b: TaskEvent[]): TaskEvent[] {
  const seen = new Set<string>()
  const all: TaskEvent[] = []
  for (const e of [...a, ...b]) {
    const key = `${e.ts}|${e.termId}|${e.tool}|${e.summary}|${e.by ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    all.push(e)
  }
  all.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))
  return all.slice(-MAX_EVENTS)
}

/** Merge `incoming` (e.g. what's on disk from a coworker) into `base` (our
 *  in-memory state). Order/identity biased toward `base`. */
export function mergeTasksState(base: TasksState, incoming: TasksState): TasksState {
  const removed = mergeTombstones(base.removed, incoming.removed)
  const tombMap = new Map(removed.map((t) => [t.id, t.ts]))
  return {
    version: 1,
    projectRoot: base.projectRoot,
    updatedAt: base.updatedAt > incoming.updatedAt ? base.updatedAt : incoming.updatedAt,
    goals: applyTombstones(mergeGoals(base.goals, incoming.goals), tombMap),
    events: mergeEvents(base.events, incoming.events),
    removed
  }
}
