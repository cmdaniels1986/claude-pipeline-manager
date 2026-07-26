import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { z } from 'zod'
import type { GraphStore } from '../graph/GraphStore'
import { edgeInputSchema, edgeKindSchema, nodeInputSchema, nodeStatusSchema, nodeTypeSchema } from '../graph/schema'

/**
 * One shared HTTP MCP server for all Claude terminals (stateless streamable-http:
 * every POST gets a fresh McpServer/transport pair bound to the shared GraphStore).
 * Terminals identify themselves via the X-Terminal-Id header set in their
 * per-terminal --mcp-config file.
 */
export class GraphMcpServer {
  private http: Server | null = null
  port = 0

  constructor(private getStore: () => GraphStore | null) {}

  async start(): Promise<number> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('MCP request error:', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    })
    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    const addr = this.http.address()
    if (addr && typeof addr === 'object') this.port = addr.port
    return this.port
  }

  stop(): void {
    this.http?.close()
    this.http = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      // stateless mode: no SSE stream, no sessions to delete
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    const termIdHeader = req.headers['x-terminal-id']
    const termId = typeof termIdHeader === 'string' ? termIdHeader : null

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined

    const server = this.buildServer(termId)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  private buildServer(termId: string | null): McpServer {
    const server = new McpServer({ name: 'graph', version: '1.0.0' })
    // compact JSON (no pretty-print) — these strings are fresh model-context tokens on every call
    const text = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }]
    })
    const noStore = () => text({ error: 'No active project — open a project folder first.' })

    server.registerTool(
      'graph_get',
      { description: 'Current pipeline graph — nodes {id,type,status,path?,note?} and edges "src>tgt" (source feeds target).' },
      async () => {
        const store = this.getStore()
        if (!store) return noStore()
        const g = store.get()
        // lean projection: drop label/description/tags/position/events and skip
        // empty fields so graph_get stays cheap even on a large pipeline
        return text({
          nodes: g.nodes.map((n) => {
            const o: Record<string, string> = { id: n.id, type: n.type, status: n.status }
            if (n.meta.path) o.path = n.meta.path
            if (n.statusNote) o.note = n.statusNote
            return o
          }),
          edges: g.edges.map((e) =>
            e.kind === 'lineage' ? `${e.source}>${e.target}` : `${e.source}>${e.target}:${e.kind}`
          )
        })
      }
    )

    server.registerTool(
      'graph_upsert_nodes',
      {
        description:
          'Create/update nodes. Stable snake_case ids matching artifact names (e.g. stg_orders); set path to the source file.',
        inputSchema: {
          nodes: z
            .array(nodeInputSchema)
            .min(1)
            .describe(
              'id (req), type ' +
                nodeTypeSchema.options.join('|') +
                ', status ' +
                nodeStatusSchema.options.join('|') +
                ', plus optional label, statusNote, path, description, tags'
            )
        }
      },
      async ({ nodes }) => {
        const store = this.getStore()
        if (!store) return noStore()
        return text(store.upsertNodes(nodes, termId))
      }
    )

    server.registerTool(
      'graph_upsert_edges',
      {
        description:
          'Create/update lineage edges (source feeds target). Missing endpoints auto-created as placeholders.',
        inputSchema: {
          edges: z
            .array(edgeInputSchema)
            .min(1)
            .describe('source, target (node ids), optional kind ' + edgeKindSchema.options.join('|'))
        }
      },
      async ({ edges }) => {
        const store = this.getStore()
        if (!store) return noStore()
        return text(store.upsertEdges(edges, termId))
      }
    )

    server.registerTool(
      'graph_set_status',
      {
        description:
          'Set a node status: in_progress (starting a change), validated (done — evidence in note), stale (downstream a change may invalidate), breaking (note what breaks).',
        inputSchema: {
          id: z.string(),
          status: nodeStatusSchema,
          note: z.string().optional().describe('why / evidence')
        }
      },
      async ({ id, status, note }) => {
        const store = this.getStore()
        if (!store) return noStore()
        return text(store.setStatus(id, status, note, termId))
      }
    )

    server.registerTool(
      'graph_remove',
      {
        description: 'Remove nodes/edges (only when the artifact was deleted). Removing a node removes its edges.',
        inputSchema: {
          nodeIds: z.array(z.string()).optional(),
          edgeIds: z.array(z.string()).optional().describe('edge ids look like "source->target"')
        }
      },
      async ({ nodeIds, edgeIds }) => {
        const store = this.getStore()
        if (!store) return noStore()
        return text(store.remove(nodeIds ?? [], edgeIds ?? [], termId))
      }
    )

    return server
  }
}
