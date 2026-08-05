import { useState } from 'react'
import type { Goal, Task, TaskScope, TaskStatus } from '../../../shared/types'
import { useContextStore } from '../stores/contextStore'
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
  const mine = useTaskStore((s) => s.mine)
  const shared = useTaskStore((s) => s.shared)
  const sharedPath = useTaskStore((s) => s.sharedPath)
  const lastEvent = useTaskStore((s) => s.lastEvent)
  const contextPosts = useContextStore((s) => s.posts)
  const contextShared = useContextStore((s) => s.sharedPath)
  const [newGoal, setNewGoal] = useState<Record<TaskScope, string>>({ mine: '', shared: '' })
  const [newTask, setNewTask] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Editing | null>(null)
  const [contextDraft, setContextDraft] = useState('')
  // when a shared task is started, we offer to post context about it
  const [sharePrompt, setSharePrompt] = useState<{ taskId: string; taskTitle: string; text: string } | null>(null)

  const hasShared = shared !== null
  const canShareContext = contextShared !== null

  const postContext = (text: string, task?: { taskId: string; taskTitle: string }): void => {
    const body = text.trim()
    if (!body) return
    void window.api.contextPost({ text: body, taskId: task?.taskId, taskTitle: task?.taskTitle })
  }

  const addGoal = (scope: TaskScope): void => {
    const title = newGoal[scope].trim()
    if (!title) return
    void window.api.tasksAddGoal({ title, scope })
    setNewGoal((m) => ({ ...m, [scope]: '' }))
  }

  const addTask = (goalId: string): void => {
    const title = (newTask[goalId] ?? '').trim()
    if (!title) return
    void window.api.tasksAddTask({ goalId, title })
    setNewTask((m) => ({ ...m, [goalId]: '' }))
  }

  const cycle = (task: Task, scope: TaskScope): void => {
    const next = NEXT[task.status]
    void window.api.tasksUpdateTask({ taskId: task.id, status: next })
    // starting a shared task → offer to share context with the coworker
    if (scope === 'shared' && next === 'doing' && canShareContext) {
      setSharePrompt({ taskId: task.id, taskTitle: task.title, text: '' })
    }
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

  const moveGoal = (goal: Goal, from: TaskScope): void => {
    const to: TaskScope = from === 'mine' ? 'shared' : 'mine'
    void window.api.tasksMoveGoal({ goalId: goal.id, scope: to })
  }

  const toggleGoalDone = (goal: Goal): void => {
    void window.api.tasksUpdateGoal({ goalId: goal.id, status: goal.status === 'done' ? 'active' : 'done' })
  }

  const goalRow = (goal: Goal, scope: TaskScope): React.JSX.Element => {
    const done = goal.tasks.filter((t) => t.status === 'done').length
    const complete = goal.status === 'done'
    return (
      <div key={goal.id} className={`goal${complete ? ' goal-done' : ''}`}>
        <div className="goal-head">
          <button
            className={`goal-check goal-check-${goal.status}`}
            onClick={() => toggleGoalDone(goal)}
            title={complete ? 'Completed — click to reopen' : 'Mark goal complete'}
          >
            {complete ? '✓' : '○'}
          </button>
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
          <button
            className="icon-button"
            title={
              scope === 'mine'
                ? hasShared
                  ? 'Move to Shared Goals (sync with coworker)'
                  : 'Set up a shared folder first (🔗 in the project switcher)'
                : 'Make private (move to My Goals)'
            }
            disabled={scope === 'mine' && !hasShared}
            onClick={() => moveGoal(goal, scope)}
          >
            {scope === 'mine' ? '🔗' : '🔒'}
          </button>
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
                onClick={() => cycle(task, scope)}
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
  }

  const section = (scope: TaskScope): React.JSX.Element => {
    const goals = (scope === 'mine' ? mine : shared)?.goals ?? []
    return (
      <section className="task-section">
        <div className="task-section-head">
          <span className="task-section-title">{scope === 'mine' ? '🔒 My Goals' : '🔗 Shared Goals'}</span>
          {scope === 'shared' && sharedPath && (
            <span className="task-section-sub" title={sharedPath}>
              synced with coworker
            </span>
          )}
        </div>
        <div className="task-add-goal">
          <input
            value={newGoal[scope]}
            placeholder={scope === 'mine' ? 'New private goal…' : 'New shared goal…'}
            onChange={(e) => setNewGoal((m) => ({ ...m, [scope]: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && addGoal(scope)}
          />
          <button className="primary" onClick={() => addGoal(scope)} disabled={!newGoal[scope].trim()}>
            ＋ Goal
          </button>
        </div>
        {goals.length === 0 && (
          <p className="task-empty">
            {scope === 'mine'
              ? 'No private goals yet. Add one above, or ask a terminal to plan its work.'
              : 'No shared goals yet — add one, or move a goal here with 🔗.'}
          </p>
        )}
        {goals.map((goal) => goalRow(goal, scope))}
      </section>
    )
  }

  const when = (iso: string): string => iso.replace('T', ' ').slice(0, 16)

  const contextSection = (): React.JSX.Element => (
    <section className="task-section context-section">
      <div className="task-section-head">
        <span className="task-section-title">📎 Shared context</span>
        <button
          className="icon-button context-open-btn"
          title="Open the shared folder (CONTEXT.md lives here)"
          onClick={() => contextShared && void window.api.projectRevealShared(contextShared)}
        >
          ↗ folder
        </button>
      </div>
      <p className="context-blurb">
        Post background for coworkers on this project — where things stand, gotchas, what you’re about to touch. Saved to{' '}
        <code>CONTEXT.md</code> in the shared folder.
      </p>

      <div className="context-composer">
        <textarea
          className="context-input"
          value={contextDraft}
          placeholder="Share context with your coworker…"
          rows={2}
          onChange={(e) => setContextDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              postContext(contextDraft)
              setContextDraft('')
            }
          }}
        />
        <button
          className="primary"
          disabled={!contextDraft.trim()}
          onClick={() => {
            postContext(contextDraft)
            setContextDraft('')
          }}
          title="Post (Ctrl/⌘+Enter)"
        >
          Post
        </button>
      </div>

      {contextPosts.length === 0 ? (
        <p className="task-empty">No shared context yet. Post the first note above.</p>
      ) : (
        <div className="context-list">
          {[...contextPosts].reverse().map((p) => (
            <div key={p.id} className="context-post">
              <div className="context-post-head">
                <span className="context-post-author">{p.author}</span>
                <span className="context-post-when">{when(p.ts)}</span>
                {p.taskTitle && <span className="context-post-task" title="Posted while working on this task">↳ {p.taskTitle}</span>}
                <span className="spacer" />
                <button
                  className="icon-button context-post-remove"
                  title="Delete this note"
                  onClick={() => window.confirm('Delete this shared context note?') && void window.api.contextRemove(p.id)}
                >
                  ✕
                </button>
              </div>
              <p className="context-post-text">{p.text}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )

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

      {sharePrompt && (
        <div className="share-prompt">
          <div className="share-prompt-title">
            🤝 You’re now working on “{sharePrompt.taskTitle}”. Share context with your coworker?
          </div>
          <textarea
            className="context-input"
            autoFocus
            rows={2}
            value={sharePrompt.text}
            placeholder="What’s the state / your plan for this task? (optional)"
            onChange={(e) => setSharePrompt((p) => (p ? { ...p, text: e.target.value } : p))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSharePrompt(null)
            }}
          />
          <div className="share-prompt-actions">
            <button
              className="primary"
              disabled={!sharePrompt.text.trim()}
              onClick={() => {
                postContext(sharePrompt.text, { taskId: sharePrompt.taskId, taskTitle: sharePrompt.taskTitle })
                setSharePrompt(null)
              }}
            >
              Share context
            </button>
            <button onClick={() => setSharePrompt(null)}>Not now</button>
          </div>
        </div>
      )}

      <div className="task-dock-body">
        {section('mine')}
        {hasShared ? (
          section('shared')
        ) : (
          <p className="task-hint">
            Want a coworker on the same board? Click 🔗 on this project in the switcher to add a{' '}
            <strong>Shared Goals</strong> list synced through a cloud folder.
          </p>
        )}
        {canShareContext && contextSection()}
      </div>
    </div>
  )
}
