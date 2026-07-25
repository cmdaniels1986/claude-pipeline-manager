import { ReactFlowProvider } from '@xyflow/react'
import { GraphView } from '../graph/GraphView'
import { useGraphStore } from '../graph/graphStore'

export function GraphDock({ onClose }: { onClose: () => void }): React.JSX.Element {
  const lastEvent = useGraphStore((s) => s.lastEvent)

  const popOut = (): void => {
    void window.api.openGraphWindow()
    onClose()
  }

  return (
    <div className="graph-dock">
      <div className="graph-dock-header">
        <span className="graph-dock-title">🗺 Pipeline Graph</span>
        {lastEvent && (
          <span className="activity" title={lastEvent.ts}>
            {lastEvent.summary}
          </span>
        )}
        <span className="spacer" />
        <button className="icon-button" onClick={popOut} title="Pop out into its own window">
          ⧉
        </button>
        <button className="icon-button" onClick={onClose} title="Close graph panel">
          ✕
        </button>
      </div>
      <div className="graph-dock-body">
        <ReactFlowProvider>
          <GraphView />
        </ReactFlowProvider>
      </div>
    </div>
  )
}
