import { create } from 'zustand'
import type { GraphEvent, GraphState, NodeStatus } from '../../../shared/types'
import type { FocusKind } from './analysis'
import { computeImpact } from './impact'

export interface GraphFilter {
  /** free-text match against id/label/path/owner/type/tags */
  query: string
  /** when non-empty, only these statuses match */
  statuses: NodeStatus[]
}

interface GraphUiStore {
  graph: GraphState | null
  lastEvent: GraphEvent | null
  selected: string | null
  upstream: Set<string>
  downstream: Set<string>
  filter: GraphFilter
  /** highlight-only-this health category (or git changes); null = off */
  focus: FocusKind | null
  /** node ids reported changed by git scoping (drives the 'changed' focus) */
  changed: Set<string>
  branch: string | null
  setGraph: (graph: GraphState | null, event: GraphEvent | null) => void
  select: (nodeId: string | null) => void
  setQuery: (query: string) => void
  toggleStatus: (status: NodeStatus) => void
  setFocus: (focus: FocusKind | null) => void
  setChanged: (ids: string[], branch: string | null) => void
  resetFilter: () => void
}

const EMPTY_FILTER: GraphFilter = { query: '', statuses: [] }

export const useGraphStore = create<GraphUiStore>((set, get) => ({
  graph: null,
  lastEvent: null,
  selected: null,
  upstream: new Set(),
  downstream: new Set(),
  filter: EMPTY_FILTER,
  focus: null,
  changed: new Set(),
  branch: null,
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
  },
  setQuery: (query) => set((s) => ({ filter: { ...s.filter, query } })),
  toggleStatus: (status) =>
    set((s) => {
      const has = s.filter.statuses.includes(status)
      return {
        filter: {
          ...s.filter,
          statuses: has ? s.filter.statuses.filter((x) => x !== status) : [...s.filter.statuses, status]
        }
      }
    }),
  setFocus: (focus) => set((s) => ({ focus: s.focus === focus ? null : focus })),
  setChanged: (ids, branch) => set({ changed: new Set(ids), branch, focus: 'changed' }),
  resetFilter: () => set({ filter: EMPTY_FILTER, focus: null })
}))

// debug handle for the CDP verification harness (mirrors __termStore)
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__graphStore = useGraphStore
}
