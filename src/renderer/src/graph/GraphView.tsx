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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNode, GraphState, NodeStatus, TermInfo } from '../../../shared/types'
import { analyzeGraph, type FocusKind, type GraphAnalysis } from './analysis'
import { useGraphStore, type GraphFilter } from './graphStore'
import { layoutGraph } from './layout'
import { NodeContextMenu, type Provenance } from './NodeContextMenu'
import { PipelineNode } from './PipelineNode'
import { STATUS_STYLES } from './statusStyles'
import { TerminalPickerDialog } from './TerminalPickerDialog'

const nodeTypes = { pipeline: PipelineNode }

const STATUS_ORDER: NodeStatus[] = ['unknown', 'in_progress', 'validated', 'stale', 'breaking']

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

/** the node-id set behind an active focus category */
function focusSetOf(focus: FocusKind | null, analysis: GraphAnalysis, changed: Set<string>): Set<string> | null {
  switch (focus) {
    case 'cycle':
      return analysis.cycle
    case 'orphan':
      return analysis.orphan
    case 'deadend':
      return analysis.deadend
    case 'placeholder':
      return analysis.placeholder
    case 'changed':
      return changed
    default:
      return null
  }
}

function nodeMatches(node: GraphNode, filter: GraphFilter, focusSet: Set<string> | null): boolean {
  if (filter.statuses.length && !filter.statuses.includes(node.status)) return false
  if (focusSet && !focusSet.has(node.id)) return false
  const q = filter.query.trim().toLowerCase()
  if (q) {
    const hay = [node.id, node.label, node.type, node.meta.path, node.meta.owner, ...(node.meta.tags ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

export function GraphView(): React.JSX.Element {
  const { graph, selected, upstream, downstream, filter, focus, changed, branch, setGraph, select } =
    useGraphStore()
  const { setQuery, toggleStatus, setFocus, setChanged, resetFilter } = useGraphStore()
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges] = useEdgesState<Edge>([])
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [scoping, setScoping] = useState(false)
  const layoutCache = useRef(new Map<string, { x: number; y: number }>())

  const analysis = useMemo<GraphAnalysis>(
    () => (graph ? analyzeGraph(graph) : { cycle: new Set(), orphan: new Set(), deadend: new Set(), placeholder: new Set() }),
    [graph]
  )
  const focusSet = focus ? focusSetOf(focus, analysis, changed) : null
  const filtering = !!(filter.query.trim() || filter.statuses.length || focus)

  useEffect(() => {
    void window.api.graphGet().then((g) => setGraph(g, null))
    return window.api.onGraphChanged(({ graph: g, event }) => setGraph(g, event))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // keep a fresh terminal list for mapping event termIds → labels/colors
  useEffect(() => {
    const refresh = (): void => {
      void window.api.termList().then(setTerms)
    }
    refresh()
    const id = window.setInterval(refresh, 4000)
    return () => window.clearInterval(id)
  }, [])

  const nodeOf = (nodeId: string): GraphNode | undefined => graph?.nodes.find((n) => n.id === nodeId)
  const nodePath = (nodeId: string): string | undefined => nodeOf(nodeId)?.meta.path

  const provenanceFor = (nodeId: string): Provenance | null => {
    if (!graph) return null
    const ev = [...graph.events].reverse().find((e) => e.termId && e.summary.includes(nodeId))
    if (!ev?.termId) return null
    const term = terms.find((t) => t.termId === ev.termId)
    return { label: term?.label ?? 'a closed session', color: term?.color }
  }

  const openNodeFile = (nodeId: string): void => {
    const path = nodePath(nodeId)
    if (!path) {
      showToast(`"${nodeId}" has no source file recorded in the graph.`)
      return
    }
    void window.api.openFile(path).then((r) => {
      if (!r.ok) showToast(r.error ?? 'Could not open file.')
    })
  }

  const revealNodeFile = (nodeId: string): void => {
    const path = nodePath(nodeId)
    if (!path) return
    void window.api.revealFile(path).then((r) => {
      if (!r.ok) showToast(r.error ?? 'Could not reveal file.')
    })
  }

  const scopeToGit = async (): Promise<void> => {
    if (focus === 'changed') {
      setFocus('changed') // toggle off
      return
    }
    setScoping(true)
    const r = await window.api.graphChangedNodes()
    setScoping(false)
    if (r.repos === 0) {
      showToast(r.reason ?? 'Could not determine git changes.')
      return
    }
    if (!r.changed.length) {
      showToast(`No graph nodes changed on ${r.branch ?? 'this branch'}.`)
      return
    }
    setChanged(r.changed, r.branch)
  }

  // Rebuild React Flow nodes/edges whenever the graph (or highlight state) changes;
  // auto-layout any nodes without a persisted position, then persist what elk decided.
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
        graph.nodes.map((n) => {
          const matched = nodeMatches(n, filter, focusSet)
          const cls = filtering && !matched ? 'filtered-out' : impactClass(n.id, selected, upstream, downstream)
          return {
            id: n.id,
            type: 'pipeline',
            position: n.position ?? layoutCache.current.get(n.id) ?? { x: 0, y: 0 },
            className: cls,
            data: {
              label: n.label,
              nodeType: n.type,
              status: n.status,
              statusNote: n.statusNote,
              path: n.meta.path,
              owner: n.meta.owner,
              placeholder: n.meta.placeholder,
              inCycle: analysis.cycle.has(n.id),
              deadEnd: analysis.deadend.has(n.id),
              orphan: analysis.orphan.has(n.id),
              changed: changed.has(n.id)
            }
          }
        })
      )
      setRfEdges(
        graph.edges.map((e) => {
          const s = nodeOf(e.source)
          const t = nodeOf(e.target)
          const dim =
            filtering && (!s || !t || !nodeMatches(s, filter, focusSet) || !nodeMatches(t, filter, focusSet))
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            className: dim ? 'dimmed' : edgeClass(e.source, e.target, selected, upstream, downstream),
            markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 }
          }
        })
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
  }, [graph, selected, upstream, downstream, filter, focus, changed, analysis])

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
        <h2>Loading…</h2>
        <p>Launch a terminal in this project — the graph appears as Claude maps your pipeline.</p>
      </div>
    )
  }

  const healthPills: { kind: FocusKind; label: string; count: number; danger?: boolean }[] = [
    { kind: 'cycle', label: 'cycle', count: analysis.cycle.size, danger: true },
    { kind: 'deadend', label: 'dead-end', count: analysis.deadend.size },
    { kind: 'orphan', label: 'orphan', count: analysis.orphan.size },
    { kind: 'placeholder', label: 'undocumented', count: analysis.placeholder.size }
  ]

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <input
          className="graph-search"
          value={filter.query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔍 search id, label, path, owner, tag…"
        />
        <div className="graph-status-chips">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              className={`status-chip${filter.statuses.includes(s) ? ' on' : ''}`}
              style={{ '--chip': STATUS_STYLES[s].dot } as React.CSSProperties}
              onClick={() => toggleStatus(s)}
              title={`Filter to ${STATUS_STYLES[s].label} nodes`}
            >
              <span className="chip-dot" style={{ background: STATUS_STYLES[s].dot }} />
              {STATUS_STYLES[s].label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {healthPills
          .filter((p) => p.count > 0)
          .map((p) => (
            <button
              key={p.kind}
              className={`health-pill${p.danger ? ' danger' : ''}${focus === p.kind ? ' on' : ''}`}
              onClick={() => setFocus(p.kind)}
              title={`${p.count} ${p.label} node(s) — click to isolate`}
            >
              {p.count} {p.label}
            </button>
          ))}
        <button
          className={`graph-tool-btn${focus === 'changed' ? ' on' : ''}`}
          onClick={() => void scopeToGit()}
          disabled={scoping}
          title="Highlight nodes whose source file changed in the current git branch"
        >
          ⎇ {scoping ? 'scanning…' : focus === 'changed' ? `changes${branch ? ` · ${branch}` : ''}` : 'changes'}
        </button>
        {filtering && (
          <button className="graph-tool-btn" onClick={resetFilter} title="Clear all filters/highlights">
            ✕ clear
          </button>
        )}
      </div>

      <div className="graph-canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_e, node) => select(node.id)}
          onNodeDoubleClick={(_e, node) => openNodeFile(node.id)}
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
      </div>

      {menu && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          nodeId={menu.nodeId}
          path={nodePath(menu.nodeId)}
          owner={nodeOf(menu.nodeId)?.meta.owner}
          lastTouched={provenanceFor(menu.nodeId)}
          onOpenFile={() => {
            setMenu(null)
            openNodeFile(menu.nodeId)
          }}
          onReveal={() => {
            setMenu(null)
            revealNodeFile(menu.nodeId)
          }}
          onSetOwner={(owner) => {
            void window.api.graphSetOwner(menu.nodeId, owner)
            setMenu(null)
          }}
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
