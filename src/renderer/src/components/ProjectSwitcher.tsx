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

  const shareTasks = async (p: ProjectInfo): Promise<void> => {
    const res = await window.api.projectPickSharedFolder()
    if (res.canceled) return
    await window.api.projectSetShared(p.id, res.path)
    window.alert(
      `“${p.name}” tasks now live in:\n${res.path}\n\nHave your coworker create a project and share it to the SAME synced folder — you'll both see the same list.`
    )
  }

  const stopSharing = async (p: ProjectInfo): Promise<void> => {
    if (
      window.confirm(
        `Stop sharing “${p.name}” tasks?\nThe current tasks are copied back into this app; the file in the shared folder stays put.`
      )
    ) {
      await window.api.projectSetShared(p.id, null)
    }
  }

  const revealShared = (p: ProjectInfo): void => {
    if (p.sharedTasksPath) void window.api.projectRevealShared(p.sharedTasksPath)
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
                      {p.sharedTasksPath && (
                        <span className="shared-badge" title={`Shared tasks: ${p.sharedTasksPath}`}>
                          🔗 shared
                        </span>
                      )}
                    </button>
                  )}
                  {p.sharedTasksPath ? (
                    <>
                      <button
                        className="icon-button"
                        title={`Shared tasks folder:\n${p.sharedTasksPath}\nClick to open`}
                        onClick={() => revealShared(p)}
                      >
                        🔗
                      </button>
                      <button
                        className="icon-button"
                        title="Stop sharing (copy tasks back to local)"
                        onClick={() => void stopSharing(p)}
                      >
                        ⊘
                      </button>
                    </>
                  ) : (
                    <button
                      className="icon-button"
                      title="Share these tasks via a synced cloud folder (OneDrive / Google Drive / Dropbox)"
                      onClick={() => void shareTasks(p)}
                    >
                      🔗
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
