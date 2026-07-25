import ELK from 'elkjs/lib/elk.bundled.js'
import type { GraphEdge, GraphNode } from '../../../shared/types'

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 62

const elk = new ELK()

/** Layered left-to-right layout over the whole graph; returns id → position. */
export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Promise<Map<string, { x: number; y: number }>> {
  if (!nodes.length) return new Map()
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '36',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.layered.mergeEdges': 'true'
    },
    children: nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  })
  const positions = new Map<string, { x: number; y: number }>()
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }
  return positions
}
