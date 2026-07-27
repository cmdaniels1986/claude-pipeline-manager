import { create } from 'zustand'
import type { TaskEvent, TasksState } from '../../../shared/types'

interface Snapshot {
  mine: TasksState | null
  shared: TasksState | null
  sharedPath: string | null
}

interface TaskUiStore extends Snapshot {
  lastEvent: TaskEvent | null
  apply: (s: Snapshot, event: TaskEvent | null) => void
}

export const useTaskStore = create<TaskUiStore>((set, get) => ({
  mine: null,
  shared: null,
  sharedPath: null,
  lastEvent: null,
  apply: (s, event) =>
    set({ mine: s.mine, shared: s.shared, sharedPath: s.sharedPath, lastEvent: event ?? get().lastEvent })
}))

if (typeof window !== 'undefined' && window.api) {
  void window.api.tasksGet().then((snap) => {
    if (snap) useTaskStore.getState().apply(snap, null)
  })
  window.api.onTasksChanged(({ mine, shared, sharedPath, event }) =>
    useTaskStore.getState().apply({ mine, shared, sharedPath }, event)
  )
}
