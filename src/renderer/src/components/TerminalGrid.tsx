import { useTerminalStore } from '../stores/terminalStore'
import { TerminalPane } from './TerminalPane'

export function TerminalGrid(): React.JSX.Element {
  const panes = useTerminalStore((s) => s.panes)

  if (!panes.length) {
    return (
      <div className="empty-state">
        <h2>No terminals yet</h2>
        <p>Open a project folder and launch your first Claude terminal.</p>
      </div>
    )
  }

  const cols = Math.ceil(Math.sqrt(panes.length))
  const rows = Math.ceil(panes.length / cols)

  return (
    <div
      className="terminal-grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`
      }}
    >
      {panes.map((pane) => (
        <TerminalPane key={pane.paneId} pane={pane} />
      ))}
    </div>
  )
}
