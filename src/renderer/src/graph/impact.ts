import type { GraphState } from '../../../shared/types'

/** BFS in both directions from a node. Edges mean: source feeds target, so
 *  downstream = follow source→target, upstream = follow target→source. */
export function computeImpact(
  graph: GraphState,
  nodeId: string
): { upstream: Set<string>; downstream: Set<string> } {
  const fwd = new Map<string, string[]>()
  const rev = new Map<string, string[]>()
  for (const e of graph.edges) {
    fwd.set(e.source, [...(fwd.get(e.source) ?? []), e.target])
    rev.set(e.target, [...(rev.get(e.target) ?? []), e.source])
  }

  const bfs = (start: string, adj: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>()
    const queue = [start]
    while (queue.length) {
      const cur = queue.shift()!
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next) && next !== start) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    return seen
  }

  return { upstream: bfs(nodeId, rev), downstream: bfs(nodeId, fwd) }
}
