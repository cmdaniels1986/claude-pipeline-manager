import { create } from 'zustand'
import type { GraphEvent, GraphState } from '../../../shared/types'
import { computeImpact } from './impact'

interface GraphUiStore {
  graph: GraphState | null
  lastEvent: GraphEvent | null
  selected: string | null
  upstream: Set<string>
  downstream: Set<string>
  setGraph: (graph: GraphState | null, event: GraphEvent | null) => void
  select: (nodeId: string | null) => void
}

export const useGraphStore = create<GraphUiStore>((set, get) => ({
  graph: null,
  lastEvent: null,
  selected: null,
  upstream: new Set(),
  downstream: new Set(),
  setGraph: (graph, event) => {
    const { selected } = get()
    const impact =
      graph && selected && graph.nodes.some((n) => n.id === selected)
        ? computeImpact(graph, selected)
        : { upstream: new Set<string>(), downstream: new Set<string>() }
    set({
      graph,
      lastEvent: event ?? get().lastEvent,
      selected: graph && selected && graph.nodes.some((n) => n.id === selected) ? selected : null,
      ...impact
    })
  },
  select: (nodeId) => {
    const { graph } = get()
    if (!nodeId || !graph) {
      set({ selected: null, upstream: new Set(), downstream: new Set() })
      return
    }
    set({ selected: nodeId, ...computeImpact(graph, nodeId) })
  }
}))
