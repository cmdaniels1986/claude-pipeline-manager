import { useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'

export function ProjectSwitcher({
  projects,
  activeId
}: {
  projects: ProjectInfo[]
  activeId: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  const active = projects.find((p) => p.id === activeId) ?? null

  const switchTo = (id: string): void => {
    if (id !== activeId) void window.api.projectSwitch(id)
    setOpen(false)
  }

  const create = (): void => {
    const name = newName.trim()
    if (!name) return
    void window.api.projectCreate(name)
    setNewName('')
    setOpen(false)
  }

  const commitRename = (): void => {
    if (editing && editing.text.trim()) void window.api.projectRename(editing.id, editing.text.trim())
    setEditing(null)
  }

  const remove = (p: ProjectInfo): void => {
    if (window.confirm(`Delete project “${p.name}” and everything in it (graph + tasks)?\nThis can't be undone.`)) {
      void window.api.projectRemove(p.id)
    }
  }

  return (
    <div className="project-switcher">
      <button className="project-button" onClick={() => setOpen((v) => !v)} title="Switch or create a project">
        📁 {active?.name ?? 'No project'} <span className="caret">▾</span>
      </button>

      {open && (
        <>
          <div className="context-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="project-menu">
            <div className="project-menu-title">Projects</div>
            <div className="project-list">
              {projects.map((p) => (
                <div key={p.id} className={`project-row${p.id === activeId ? ' active' : ''}`}>
                  {editing?.id === p.id ? (
                    <input
                      className="project-rename"
                      autoFocus
                      value={editing.text}
                      onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                  ) : (
                    <button
                      className="project-name"
                      onClick={() => switchTo(p.id)}
                      onDoubleClick={() => setEditing({ id: p.id, text: p.name })}
                      title="Click to open · double-click to rename"
                    >
                      {p.id === activeId ? '● ' : '○ '}
                      {p.name}
                    </button>
                  )}
                  <button
                    className="icon-button"
                    title="Rename"
                    onClick={() => setEditing({ id: p.id, text: p.name })}
                  >
                    ✎
                  </button>
                  <button className="icon-button" title="Delete project" onClick={() => remove(p)}>
                    🗑
                  </button>
                </div>
              ))}
            </div>

            <div className="project-new">
              <input
                value={newName}
                placeholder="New project name…"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
              />
              <button className="primary" onClick={create} disabled={!newName.trim()}>
                ＋
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
