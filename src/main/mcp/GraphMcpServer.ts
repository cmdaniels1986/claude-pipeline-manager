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
    const text = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    })
    const noStore = () =>
      text({ error: 'No active project — open a project folder in Claude Pipeline Manager first.' })

    server.registerTool(
      'graph_get',
      {
        description:
          'Get the current shared pipeline graph: all nodes (with statuses), all edges (source feeds target), and recent change events.'
      },
      async () => {
        const store = this.getStore()
        if (!store) return noStore()
        const g = store.get()
        return text({
          projectRoot: g.projectRoot,
          updatedAt: g.updatedAt,
          nodes: g.nodes.map(({ position: _position, ...n }) => n),
          edges: g.edges,
          recentEvents: g.events.slice(-10)
        })
      }
    )

    server.registerTool(
      'graph_upsert_nodes',
      {
        description:
          'Create or update pipeline graph nodes (datasets/models/tables/sources). Use stable snake_case ids matching artifact names, e.g. "stg_orders". Include meta path when known.',
        inputSchema: {
          nodes: z
            .array(nodeInputSchema)
            .min(1)
            .describe(
              'Nodes to create/update. Fields: id (required), label, type (' +
                nodeTypeSchema.options.join('|') +
                '), status (' +
                nodeStatusSchema.options.join('|') +
                '), statusNote, path (source file), description, tags'
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
          'Create or update lineage edges. An edge means: source feeds target. Missing endpoint nodes are auto-created as placeholders (fill them in with graph_upsert_nodes).',
        inputSchema: {
          edges: z
            .array(edgeInputSchema)
            .min(1)
            .describe('Edges. Fields: source, target (node ids), kind (' + edgeKindSchema.options.join('|') + ')')
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
          'Set a node validation status. Use in_progress when starting a change, validated when verified done (include evidence in note), stale for downstream nodes your change may invalidate, breaking when something is incompatible (say exactly what breaks in note).',
        inputSchema: {
          id: z.string().describe('Node id'),
          status: nodeStatusSchema,
          note: z.string().optional().describe('Why / evidence')
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
        description:
          'Remove nodes and/or edges from the graph. Only use when the underlying artifact was actually deleted. Removing a node also removes its edges.',
        inputSchema: {
          nodeIds: z.array(z.string()).optional(),
          edgeIds: z.array(z.string()).optional().describe('Edge ids look like "source->target"')
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
