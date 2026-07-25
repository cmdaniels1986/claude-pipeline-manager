import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node
} from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphState } from '../../../shared/types'
import { useGraphStore } from './graphStore'
import { layoutGraph } from './layout'
import { NodeContextMenu } from './NodeContextMenu'
import { PipelineNode } from './PipelineNode'
import { TerminalPickerDialog } from './TerminalPickerDialog'

const nodeTypes = { pipeline: PipelineNode }

function impactClass(
  id: string,
  selected: string | null,
  upstream: Set<string>,
  downstream: Set<string>
): string {
  if (!selected) return ''
  if (id === selected) return 'impact-sel'
  if (upstream.has(id)) return 'impact-up'
  if (downstream.has(id)) return 'impact-down'
  return 'dimmed'
}

function edgeClass(
  source: string,
  target: string,
  selected: string | null,
  upstream: Set<string>,
  downstream: Set<string>
): string {
  if (!selected) return ''
  const inImpact = (id: string): boolean => id === selected || upstream.has(id) || downstream.has(id)
  return inImpact(source) && inImpact(target) ? 'impact-edge' : 'dimmed'
}

export function GraphView(): React.JSX.Element {
  const { graph, selected, upstream, downstream, setGraph, select } = useGraphStore()
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges] = useEdgesState<Edge>([])
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const layoutCache = useRef(new Map<string, { x: number; y: number }>())

  useEffect(() => {
    void window.api.graphGet().then((g) => setGraph(g, null))
    return window.api.onGraphChanged(({ graph: g, event }) => setGraph(g, event))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Rebuild React Flow nodes/edges whenever the graph changes; auto-layout any
  // nodes without a persisted position, then persist what elk decided.
  useEffect(() => {
    if (!graph) {
      setRfNodes([])
      setRfEdges([])
      return
    }
    let cancelled = false

    const build = (): void => {
      if (cancelled) return
      setRfNodes(
        graph.nodes.map((n) => ({
          id: n.id,
          type: 'pipeline',
          position: n.position ?? layoutCache.current.get(n.id) ?? { x: 0, y: 0 },
          className: impactClass(n.id, selected, upstream, downstream),
          data: {
            label: n.label,
            nodeType: n.type,
            status: n.status,
            statusNote: n.statusNote,
            path: n.meta.path,
            placeholder: n.meta.placeholder
          }
        }))
      )
      setRfEdges(
        graph.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          className: edgeClass(e.source, e.target, selected, upstream, downstream),
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 }
        }))
      )
    }

    const missing = graph.nodes.filter((n) => !n.position && !layoutCache.current.has(n.id))
    if (missing.length) {
      void layoutGraph(graph.nodes, graph.edges).then((positions) => {
        if (cancelled) return
        const hasManual = graph.nodes.some((n) => n.position)
        const targets = hasManual ? missing : graph.nodes
        const toPersist: { id: string; position: { x: number; y: number } }[] = []
        for (const n of targets) {
          const pos = positions.get(n.id)
          if (pos) {
            layoutCache.current.set(n.id, pos)
            toPersist.push({ id: n.id, position: pos })
          }
        }
        build()
        if (toPersist.length) void window.api.graphSetPositions(toPersist)
      })
    } else {
      build()
    }

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, selected, upstream, downstream])

  const relayout = useCallback(async (): Promise<void> => {
    if (!graph) return
    const positions = await layoutGraph(graph.nodes, graph.edges)
    layoutCache.current = new Map(positions)
    const all = [...positions.entries()].map(([id, position]) => ({ id, position }))
    await window.api.graphSetPositions(all)
  }, [graph])

  const showToast = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 4000)
  }

  if (!graph) {
    return (
      <div className="empty-state">
        <h2>No active project</h2>
        <p>Open a project folder and launch a terminal in the main window — the graph appears as Claude maps your pipeline.</p>
      </div>
    )
  }

  return (
    <div className="graph-view">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, node) => select(node.id)}
        onPaneClick={() => {
          select(null)
          setMenu(null)
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
        }}
        onNodeDragStop={(_e, node) => {
          void window.api.graphSetPositions([{ id: node.id, position: node.position }])
        }}
        colorMode="dark"
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={24} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>

      <button className="relayout-button" onClick={() => void relayout()} title="Re-run automatic layout">
        ⟲ Auto-layout
      </button>

      {menu && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          nodeId={menu.nodeId}
          onPick={(text) => {
            setMenu(null)
            setPendingPrompt(text)
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {pendingPrompt && (
        <TerminalPickerDialog
          promptText={pendingPrompt}
          onDone={(label) => {
            setPendingPrompt(null)
            showToast(`Prompt sent to ${label}`)
          }}
          onClose={() => setPendingPrompt(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export type { GraphState }
