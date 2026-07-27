import { useCallback, useEffect, useState } from 'react'
import type { Diagnostics, ProjectInfo, UpdateStatus } from '../../shared/types'
import { GraphDock } from './components/GraphDock'
import { NewTerminalDialog } from './components/NewTerminalDialog'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { TaskDock } from './components/TaskDock'
import { TerminalTabs } from './components/TerminalTabs'
import { sessionBadge, sessionTotals } from './components/usageFormat'
import { useTerminalStore } from './stores/terminalStore'

const MIN_GRAPH_WIDTH = 340
const MIN_TERMINALS_WIDTH = 420

export default function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [showWarnings, setShowWarnings] = useState(false)
  const [rightView, setRightView] = useState<'graph' | 'tasks' | null>('graph')
  const [graphWidth, setGraphWidth] = useState(Math.round(window.innerWidth * 0.42))
  const [dragging, setDragging] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateState, setUpdateState] = useState<'idle' | 'working' | 'restarting' | string>('idle')
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [login, setLogin] = useState<{ checking: boolean; ok?: boolean; detail?: string } | null>(null)
  const usage = useTerminalStore((s) => s.usage)
  const billingReal = useTerminalStore((s) => s.billingReal)
  const totals = sessionTotals(usage)

  useEffect(() => {
    void window.api.projectsList().then(({ projects, activeId }) => {
      setProjects(projects)
      setActiveId(activeId)
    })
    void window.api.getDiagnostics().then(setDiag)
    // re-attach to sessions still running in the main process (survives an
    // idle/sleep-triggered page reload, which would otherwise blank the tabs)
    void window.api.reconcileTerminals().then((terms) => {
      const store = useTerminalStore.getState()
      for (const t of terms) {
        store.adoptPane({ termId: t.termId, label: t.label, cwd: t.cwd, color: t.color })
        void window.api.termClaim(t.termId)
      }
    })
    const offProjects = window.api.onProjectsChanged(({ projects, activeId }) => {
      setProjects(projects)
      setActiveId(activeId)
    })
    const offUpdates = window.api.onUpdatesAvailable(setUpdate)
    return () => {
      offProjects()
      offUpdates()
    }
  }, [])

  const runLoginCheck = async (): Promise<void> => {
    setLogin({ checking: true })
    const result = await window.api.checkLogin()
    setLogin({ checking: false, ok: result.ok, detail: result.detail })
  }

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    setUpdateNote(null)
    const r = await window.api.updatesCheck()
    setChecking(false)
    if (r.ok && r.behind) {
      setUpdate({ behind: r.behind, latest: r.latest ?? '' })
    } else if (r.ok) {
      setUpdateNote('✓ Up to date — you’re on the latest version.')
    } else {
      setUpdateNote('⚠ Couldn’t check for updates: ' + (r.reason ?? 'unknown error'))
    }
  }

  const runUpdate = async (): Promise<void> => {
    setUpdateState('working')
    const result = await window.api.updatesApply()
    if (result.ok) {
      setUpdateState('restarting')
    } else {
      setUpdateState(result.error ?? 'Update failed')
    }
  }

  const startDivider = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = graphWidth
      setDragging(true)
      const onMove = (ev: MouseEvent): void => {
        const next = startWidth + (startX - ev.clientX)
        const max = window.innerWidth - MIN_TERMINALS_WIDTH
        setGraphWidth(Math.min(Math.max(next, MIN_GRAPH_WIDTH), max))
      }
      const onUp = (): void => {
        setDragging(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [graphWidth]
  )

  const activeProject = projects.find((p) => p.id === activeId) ?? null

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">Claude Pipeline Manager</span>
        <ProjectSwitcher projects={projects} activeId={activeId} />
        <button className="primary" onClick={() => setDialogOpen(true)}>
          ＋ New Terminal
        </button>
        <button
          className={rightView === 'graph' ? 'toggled' : ''}
          onClick={() => setRightView((v) => (v === 'graph' ? null : 'graph'))}
          title={rightView === 'graph' ? 'Hide the graph panel' : 'Show the pipeline graph'}
        >
          🗺 Pipeline Graph
        </button>
        <button
          className={rightView === 'tasks' ? 'toggled' : ''}
          onClick={() => setRightView((v) => (v === 'tasks' ? null : 'tasks'))}
          title={rightView === 'tasks' ? 'Hide the tasks panel' : 'Show goals & tasks'}
        >
          ✓ Goals &amp; Tasks
        </button>
        <button
          onClick={() => void runLoginCheck()}
          disabled={login?.checking}
          title="Test that Claude is logged in on this machine"
        >
          🔑 {login?.checking ? 'Checking…' : 'Check login'}
        </button>
        <button onClick={() => void checkUpdates()} disabled={checking} title="Check GitHub for a newer version now">
          ⟳ {checking ? 'Checking…' : 'Updates'}
        </button>
        <span className="spacer" />
        {totals.terminals > 0 && (
          <span
            className="session-usage"
            title={`Total usage across all ${totals.terminals} terminal${totals.terminals > 1 ? 's' : ''} since you opened the app${billingReal ? '' : ' (≈ = notional; subscription is flat-rate)'}`}
          >
            Σ {sessionBadge(totals, billingReal)}
            <span className="session-usage-terms">{totals.terminals} term{totals.terminals > 1 ? 's' : ''}</span>
          </span>
        )}
        {diag && (
          <span className="diag" title={`Claude ${diag.claudeVersion} · graph MCP on :${diag.mcpPort}`}>
            {diag.claudeVersion.split(' ')[0]} · MCP :{diag.mcpPort}
            {diag.warnings.length > 0 && (
              <button className="warn-badge" onClick={() => setShowWarnings((v) => !v)}>
                ⚠ {diag.warnings.length}
              </button>
            )}
          </span>
        )}
      </header>

      {update && update.behind > 0 && (
        <div className="update-banner">
          {updateState === 'idle' && (
            <>
              <span>
                ⬆ Update available — {update.behind} commit{update.behind > 1 ? 's' : ''} behind: “{update.latest}”
              </span>
              <button className="primary" onClick={() => void runUpdate()}>
                Update &amp; restart
              </button>
              <button className="icon-button" onClick={() => setUpdate(null)} title="Dismiss">
                ✕
              </button>
            </>
          )}
          {updateState === 'working' && <span>⬇ Downloading update and reinstalling dependencies…</span>}
          {updateState === 'restarting' && (
            <span>✅ Updated — restarting. (If the app doesn't come back, start it again from the launcher.)</span>
          )}
          {updateState !== 'idle' && updateState !== 'working' && updateState !== 'restarting' && (
            <>
              <span>⚠ {updateState}</span>
              <button className="icon-button" onClick={() => setUpdate(null)} title="Dismiss">
                ✕
              </button>
            </>
          )}
        </div>
      )}

      {updateNote && (
        <div className={updateNote.startsWith('✓') ? 'login-banner ok' : 'login-banner bad'}>
          <span>{updateNote}</span>
          <span className="spacer" />
          <button className="icon-button" onClick={() => setUpdateNote(null)} title="Dismiss">
            ✕
          </button>
        </div>
      )}

      {login && !login.checking && (
        <div className={login.ok ? 'login-banner ok' : 'login-banner bad'}>
          <span>
            {login.ok ? '✅ ' : '⚠ '}
            {login.ok
              ? 'Claude is logged in on this machine.'
              : "Claude is NOT responding on this machine — likely not logged in. Open a terminal, run `claude`, log in, then relaunch."}
          </span>
          {login.detail && <code className="login-detail">{login.detail}</code>}
          <span className="spacer" />
          <button className="icon-button" onClick={() => setLogin(null)} title="Dismiss">
            ✕
          </button>
        </div>
      )}

      {showWarnings && diag && diag.warnings.length > 0 && (
        <div className="warn-banner">
          {diag.warnings.map((w, i) => (
            <p key={i}>⚠ {w}</p>
          ))}
        </div>
      )}

      <main className="app-main split">
        <div className="split-left">
          <TerminalTabs onNewTerminal={() => setDialogOpen(true)} />
        </div>
        {rightView && (
          <>
            <div className="split-divider" onMouseDown={startDivider} />
            <div className="split-right" style={{ width: graphWidth }}>
              {rightView === 'graph' ? (
                <GraphDock onClose={() => setRightView(null)} />
              ) : (
                <TaskDock onClose={() => setRightView(null)} />
              )}
            </div>
          </>
        )}
        {dragging && <div className="drag-overlay" />}
      </main>

      {dialogOpen && (
        <NewTerminalDialog
          projectRoot={activeProject?.root ?? null}
          projectName={activeProject?.name ?? null}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
