import { useState } from 'react'
import type { Goal, Task, TaskStatus } from '../../../shared/types'
import { useTaskStore } from '../stores/taskStore'

const NEXT: Record<TaskStatus, TaskStatus> = { todo: 'doing', doing: 'done', done: 'todo' }
const STATUS_GLYPH: Record<TaskStatus, string> = { todo: '○', doing: '◐', done: '✓' }
const STATUS_TITLE: Record<TaskStatus, string> = {
  todo: 'To do — click to mark in progress',
  doing: 'In progress — click to mark done',
  done: 'Done — click to reopen'
}

interface Editing {
  id: string
  text: string
}

export function TaskDock({ onClose }: { onClose: () => void }): React.JSX.Element {
  const tasks = useTaskStore((s) => s.tasks)
  const lastEvent = useTaskStore((s) => s.lastEvent)
  const [newGoal, setNewGoal] = useState('')
  const [newTask, setNewTask] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Editing | null>(null)

  const goals = tasks?.goals ?? []

  const addGoal = (): void => {
    const title = newGoal.trim()
    if (!title) return
    void window.api.tasksAddGoal({ title })
    setNewGoal('')
  }

  const addTask = (goalId: string): void => {
    const title = (newTask[goalId] ?? '').trim()
    if (!title) return
    void window.api.tasksAddTask({ goalId, title })
    setNewTask((m) => ({ ...m, [goalId]: '' }))
  }

  const cycle = (task: Task): void => {
    void window.api.tasksUpdateTask({ taskId: task.id, status: NEXT[task.status] })
  }

  const commitEdit = (kind: 'goal' | 'task'): void => {
    if (!editing) return
    const title = editing.text.trim()
    if (title) {
      if (kind === 'goal') void window.api.tasksUpdateGoal({ goalId: editing.id, title })
      else void window.api.tasksUpdateTask({ taskId: editing.id, title })
    }
    setEditing(null)
  }

  const removeGoal = (goal: Goal): void => {
    const extra = goal.tasks.length ? ` and its ${goal.tasks.length} task(s)` : ''
    if (window.confirm(`Delete goal “${goal.title}”${extra}?`)) void window.api.tasksRemove([goal.id])
  }

  return (
    <div className="graph-dock">
      <div className="graph-dock-header">
        <span className="graph-dock-title">✓ Goals &amp; Tasks</span>
        {lastEvent && (
          <span className="activity" title={lastEvent.ts}>
            {lastEvent.termId ? '🤖 ' : '✎ '}
            {lastEvent.summary}
            {lastEvent.by && <span className="activity-by"> · {lastEvent.by}</span>}
          </span>
        )}
        <span className="spacer" />
        <button className="icon-button" onClick={onClose} title="Close panel">
          ✕
        </button>
      </div>

      <div className="task-dock-body">
        <div className="task-add-goal">
          <input
            value={newGoal}
            placeholder="New goal…"
            onChange={(e) => setNewGoal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addGoal()}
          />
          <button className="primary" onClick={addGoal} disabled={!newGoal.trim()}>
            ＋ Goal
          </button>
        </div>

        {goals.length === 0 && (
          <p className="task-empty">
            No goals yet. Add one above, or ask a terminal to plan its work — agents keep this board
            updated as they go.
          </p>
        )}

        {goals.map((goal) => {
          const done = goal.tasks.filter((t) => t.status === 'done').length
          return (
            <div key={goal.id} className="goal">
              <div className="goal-head">
                {editing?.id === goal.id ? (
                  <input
                    className="goal-edit"
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ id: goal.id, text: e.target.value })}
                    onBlur={() => commitEdit('goal')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit('goal')
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <span
                    className="goal-title"
                    title="Double-click to rename"
                    onDoubleClick={() => setEditing({ id: goal.id, text: goal.title })}
                  >
                    {goal.title}
                  </span>
                )}
                {goal.tasks.length > 0 && (
                  <span className={`goal-progress${done === goal.tasks.length ? ' complete' : ''}`}>
                    {done}/{goal.tasks.length}
                  </span>
                )}
                <button className="icon-button goal-remove" onClick={() => removeGoal(goal)} title="Delete goal">
                  ✕
                </button>
              </div>
              {goal.note && <p className="goal-note">{goal.note}</p>}

              <div className="task-list">
                {goal.tasks.map((task) => (
                  <div key={task.id} className={`task task-${task.status}`}>
                    <button
                      className={`task-status task-status-${task.status}`}
                      onClick={() => cycle(task)}
                      title={STATUS_TITLE[task.status]}
                    >
                      {STATUS_GLYPH[task.status]}
                    </button>
                    {editing?.id === task.id ? (
                      <input
                        className="task-edit"
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ id: task.id, text: e.target.value })}
                        onBlur={() => commitEdit('task')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit('task')
                          if (e.key === 'Escape') setEditing(null)
                        }}
                      />
                    ) : (
                      <span
                        className="task-title"
                        title={task.note ?? 'Double-click to rename'}
                        onDoubleClick={() => setEditing({ id: task.id, text: task.title })}
                      >
                        {task.title}
                      </span>
                    )}
                    {task.status === 'doing' && task.updatedBy && (
                      <span className="task-who" title={`In progress · ${task.updatedBy}`}>
                        {task.updatedBy}
                      </span>
                    )}
                    <button
                      className="icon-button task-remove"
                      onClick={() => void window.api.tasksRemove([task.id])}
                      title="Delete task"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <input
                className="task-add"
                value={newTask[goal.id] ?? ''}
                placeholder="＋ Add task…"
                onChange={(e) => setNewTask((m) => ({ ...m, [goal.id]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && addTask(goal.id)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
