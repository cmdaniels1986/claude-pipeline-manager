import { useCallback, useEffect, useState } from 'react'
import type { Diagnostics } from '../../shared/types'
import { GraphDock } from './components/GraphDock'
import { NewTerminalDialog } from './components/NewTerminalDialog'
import { TerminalGrid } from './components/TerminalGrid'

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

  useEffect(() => {
    void window.api.getActiveProject().then(setProject)
    void window.api.getDiagnostics().then(setDiag)
    return window.api.onProjectChanged(setProject)
  }, [])

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

      {showWarnings && diag && diag.warnings.length > 0 && (
        <div className="warn-banner">
          {diag.warnings.map((w, i) => (
            <p key={i}>⚠ {w}</p>
          ))}
        </div>
      )}

      <main className="app-main split">
        <div className="split-left">
          <TerminalGrid />
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
