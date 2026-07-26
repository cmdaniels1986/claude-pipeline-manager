import type { GraphNode, GraphState, NodeStatus } from '../../shared/types'

const NODE_W = 200
const NODE_H = 62
const STATUS: Record<NodeStatus, { color: string; label: string }> = {
  unknown: { color: '#8b949e', label: 'unknown' },
  in_progress: { color: '#e3b341', label: 'in progress' },
  validated: { color: '#3fb950', label: 'validated' },
  stale: { color: '#f0883e', label: 'stale' },
  breaking: { color: '#f85149', label: 'BREAKING' }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Assign positions to nodes: use stored layout, fall back to a stacked column
 *  for any node that was never laid out. */
function positions(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  let fallbackRow = 0
  const laidOut = nodes.filter((n) => n.position)
  const maxX = laidOut.reduce((m, n) => Math.max(m, n.position!.x), 0)
  for (const n of nodes) {
    if (n.position) pos.set(n.id, n.position)
    else pos.set(n.id, { x: maxX + NODE_W + 120, y: fallbackRow++ * (NODE_H + 24) })
  }
  return pos
}

export function exportGraphHtml(graph: GraphState): string {
  const pos = positions(graph.nodes)
  const pts = [...pos.values()]
  const minX = Math.min(0, ...pts.map((p) => p.x))
  const minY = Math.min(0, ...pts.map((p) => p.y))
  const maxX = Math.max(NODE_W, ...pts.map((p) => p.x + NODE_W))
  const maxY = Math.max(NODE_H, ...pts.map((p) => p.y + NODE_H))
  const pad = 40
  const vbW = maxX - minX + pad * 2
  const vbH = maxY - minY + pad * 2

  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  const edgeSvg = graph.edges
    .map((e) => {
      const s = pos.get(e.source)
      const t = pos.get(e.target)
      if (!s || !t) return ''
      const x1 = s.x + NODE_W
      const y1 = s.y + NODE_H / 2
      const x2 = t.x
      const y2 = t.y + NODE_H / 2
      const mx = (x1 + x2) / 2
      return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" class="edge" marker-end="url(#arrow)"/>`
    })
    .join('\n')

  const nodeSvg = graph.nodes
    .map((n) => {
      const p = pos.get(n.id)!
      const st = STATUS[n.status]
      const tip = [n.meta.path, n.statusNote].filter(Boolean).join('\n')
      return `<g transform="translate(${p.x},${p.y})">
  ${tip ? `<title>${esc(tip)}</title>` : ''}
  <rect width="${NODE_W}" height="${NODE_H}" rx="9" class="node" style="stroke:${st.color}"/>
  <text x="10" y="18" class="ntype">${esc(n.type)}</text>
  <text x="${NODE_W - 10}" y="18" class="nstatus" style="fill:${st.color}" text-anchor="end">● ${esc(st.label)}</text>
  <text x="10" y="42" class="nlabel">${esc(n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label)}</text>
</g>`
    })
    .join('\n')

  const legend = (Object.keys(STATUS) as NodeStatus[])
    .map((s) => `<span class="lg"><i style="background:${STATUS[s].color}"></i>${STATUS[s].label}</span>`)
    .join('')

  const name = graph.projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? graph.projectRoot
  const nodeCount = graph.nodes.length
  const edgeCount = graph.edges.length
  const validated = graph.nodes.filter((n) => n.status === 'validated').length
  const breaking = graph.nodes.filter((n) => n.status === 'breaking').length
  void byId

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Pipeline — ${esc(name)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0d1117; color:#e6edf3; font-family:'Segoe UI',system-ui,sans-serif; }
  header { padding:14px 18px; border-bottom:1px solid #3d444d; display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; }
  .meta { color:#8b949e; font-size:12px; }
  .legend { display:flex; gap:14px; margin-left:auto; }
  .lg { display:inline-flex; align-items:center; gap:5px; color:#8b949e; font-size:12px; }
  .lg i { width:9px; height:9px; border-radius:50%; display:inline-block; }
  .wrap { width:100%; height:calc(100vh - 58px); overflow:auto; }
  svg { display:block; }
  .node { fill:#161b22; stroke-width:2; }
  .ntype { fill:#8b949e; font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
  .nstatus { font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
  .nlabel { fill:#e6edf3; font-family:'Cascadia Mono',Consolas,monospace; font-size:13px; font-weight:600; }
  .edge { fill:none; stroke:#6e7681; stroke-width:1.5; }
  footer { padding:8px 18px; color:#6e7681; font-size:11px; border-top:1px solid #21262d; }
</style></head>
<body>
<header>
  <h1>🗺 ${esc(name)}</h1>
  <span class="meta">${nodeCount} nodes · ${edgeCount} edges · ${validated} validated${breaking ? ` · ${breaking} breaking` : ''}</span>
  <span class="legend">${legend}</span>
</header>
<div class="wrap">
<svg viewBox="${minX - pad} ${minY - pad} ${vbW} ${vbH}" width="${vbW}" height="${vbH}" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6e7681"/></marker></defs>
  ${edgeSvg}
  ${nodeSvg}
</svg>
</div>
<footer>Pipeline snapshot exported from Claude Pipeline Manager · ${esc(graph.updatedAt)}</footer>
</body></html>`
}
