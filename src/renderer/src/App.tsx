import { useCallback, useEffect, useState } from 'react'
import type { Diagnostics, UpdateStatus } from '../../shared/types'
import { GraphDock } from './components/GraphDock'
import { NewTerminalDialog } from './components/NewTerminalDialog'
import { TerminalTabs } from './components/TerminalTabs'
import { useTerminalStore } from './stores/terminalStore'

const MIN_GRAPH_WIDTH = 340
const MIN_TERMINALS_WIDTH = 420

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [showWarnings, setShowWarnings] = useState(false)
  const [showGraph, setShowGraph] = useState(true)
  const [graphWidth, setGraphWidth] = useState(Math.round(window.innerWidth * 0.42))
  const [dragging, setDragging] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateState, setUpdateState] = useState<'idle' | 'working' | 'restarting' | string>('idle')
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [login, setLogin] = useState<{ checking: boolean; ok?: boolean; detail?: string } | null>(null)

  useEffect(() => {
    void window.api.getActiveProject().then(setProject)
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
    const offProject = window.api.onProjectChanged(setProject)
    const offUpdates = window.api.onUpdatesAvailable(setUpdate)
    return () => {
      offProject()
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

  const pickProject = async (): Promise<void> => {
    const picked = await window.api.pickFolder()
    if (picked) {
      await window.api.setActiveProject(picked)
      setProject(picked)
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

  const projectName = project ? (project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? project) : null

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">Claude Pipeline Manager</span>
        <button onClick={() => void pickProject()} title={project ?? 'No project selected'}>
          📁 {projectName ?? 'Open project…'}
        </button>
        <button className="primary" onClick={() => setDialogOpen(true)}>
          ＋ New Terminal
        </button>
        <button
          className={showGraph ? 'toggled' : ''}
          onClick={() => setShowGraph((v) => !v)}
          title={showGraph ? 'Hide the graph panel' : 'Show the graph panel'}
        >
          🗺 Pipeline Graph
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
        {showGraph && (
          <>
            <div className="split-divider" onMouseDown={startDivider} />
            <div className="split-right" style={{ width: graphWidth }}>
              <GraphDock onClose={() => setShowGraph(false)} />
            </div>
          </>
        )}
        {dragging && <div className="drag-overlay" />}
      </main>

      {dialogOpen && <NewTerminalDialog defaultCwd={project} onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
