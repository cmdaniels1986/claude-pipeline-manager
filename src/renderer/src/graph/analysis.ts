import type { GraphState } from '../../../shared/types'

export type FocusKind = 'cycle' | 'orphan' | 'deadend' | 'placeholder' | 'changed'

export interface GraphAnalysis {
  /** nodes that participate in a dependency cycle (SCC size > 1, or a self-loop) */
  cycle: Set<string>
  /** nodes with no edges at all — disconnected from the pipeline */
  orphan: Set<string>
  /** produced artifacts (have upstream) that nothing consumes and aren't reports */
  deadend: Set<string>
  /** referenced by an edge but never described (auto-created endpoints) */
  placeholder: Set<string>
}

const TERMINAL_TYPES = new Set(['report']) // meant to be leaves — not "dead ends"

/** All local, deterministic, zero-token graph health checks. */
export function analyzeGraph(graph: GraphState): GraphAnalysis {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const out = new Map<string, string[]>()
  const inn = new Map<string, string[]>()
  for (const id of ids) {
    out.set(id, [])
    inn.set(id, [])
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    out.get(e.source)!.push(e.target)
    inn.get(e.target)!.push(e.source)
  }

  const orphan = new Set<string>()
  const deadend = new Set<string>()
  const placeholder = new Set<string>()
  for (const n of graph.nodes) {
    const outDeg = out.get(n.id)!.length
    const inDeg = inn.get(n.id)!.length
    if (outDeg === 0 && inDeg === 0) orphan.add(n.id)
    if (outDeg === 0 && inDeg > 0 && !TERMINAL_TYPES.has(n.type)) deadend.add(n.id)
    if (n.meta.placeholder) placeholder.add(n.id)
  }

  return { cycle: tarjanCycles(ids, out), orphan, deadend, placeholder }
}

/** Tarjan's SCC — nodes in a component of size > 1 (or a self-loop) are in a cycle. */
function tarjanCycles(ids: Set<string>, out: Map<string, string[]>): Set<string> {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycle = new Set<string>()

  // explicit stack to avoid blowing the call stack on large graphs
  const strongconnect = (root: string): void => {
    const work: { node: string; i: number }[] = [{ node: root, i: 0 }]
    idx.set(root, index)
    low.set(root, index)
    index++
    stack.push(root)
    onStack.add(root)

    while (work.length) {
      const frame = work[work.length - 1]
      const { node } = frame
      const neighbors = out.get(node)!
      if (frame.i < neighbors.length) {
        const next = neighbors[frame.i]
        frame.i++
        if (!idx.has(next)) {
          idx.set(next, index)
          low.set(next, index)
          index++
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, i: 0 })
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node)!, idx.get(next)!))
        }
      } else {
        if (low.get(node) === idx.get(node)) {
          const comp: string[] = []
          let w: string
          do {
            w = stack.pop()!
            onStack.delete(w)
            comp.push(w)
          } while (w !== node)
          if (comp.length > 1) for (const c of comp) cycle.add(c)
        }
        work.pop()
        if (work.length) {
          const parent = work[work.length - 1].node
          low.set(parent, Math.min(low.get(parent)!, low.get(node)!))
        }
      }
    }
  }

  for (const id of ids) if (!idx.has(id)) strongconnect(id)

  // self-loops (a node depending on itself) are cycles Tarjan's size>1 rule misses
  for (const [id, neighbors] of out) if (neighbors.includes(id)) cycle.add(id)

  return cycle
}
