import { create } from 'zustand'
import type { TaskEvent, TasksState } from '../../../shared/types'

interface TaskUiStore {
  tasks: TasksState | null
  lastEvent: TaskEvent | null
  setTasks: (tasks: TasksState | null, event: TaskEvent | null) => void
}

export const useTaskStore = create<TaskUiStore>((set, get) => ({
  tasks: null,
  lastEvent: null,
  setTasks: (tasks, event) => set({ tasks, lastEvent: event ?? get().lastEvent })
}))

if (typeof window !== 'undefined' && window.api) {
  void window.api.tasksGet().then((tasks) => useTaskStore.getState().setTasks(tasks, null))
  window.api.onTasksChanged(({ tasks, event }) => useTaskStore.getState().setTasks(tasks, event))
}
