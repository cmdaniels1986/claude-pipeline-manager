import { ReactFlowProvider } from '@xyflow/react'
import { GraphView } from './GraphView'
import { useGraphStore } from './graphStore'
import { STATUS_STYLES } from './statusStyles'
import type { NodeStatus } from '../../../shared/types'

const LEGEND: NodeStatus[] = ['unknown', 'in_progress', 'validated', 'stale', 'breaking']

export default function GraphApp(): React.JSX.Element {
  const graph = useGraphStore((s) => s.graph)
  const lastEvent = useGraphStore((s) => s.lastEvent)

  const projectName = graph
    ? (graph.projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? graph.projectRoot)
    : null

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">🗺 Pipeline Graph{projectName ? ` — ${projectName}` : ''}</span>
        <span className="legend">
          {LEGEND.map((s) => (
            <span key={s} className="legend-item">
              <span className="legend-dot" style={{ background: STATUS_STYLES[s].dot }} />
              {STATUS_STYLES[s].label}
            </span>
          ))}
        </span>
        <span className="spacer" />
        {lastEvent && (
          <span className="activity" title={lastEvent.ts}>
            {lastEvent.summary}
          </span>
        )}
      </header>
      <main className="app-main">
        <ReactFlowProvider>
          <GraphView />
        </ReactFlowProvider>
      </main>
    </div>
  )
}
