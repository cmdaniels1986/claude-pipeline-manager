import { EventEmitter } from 'events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { GraphEvent, GraphNode, GraphState } from '../../shared/types'
import { graphStateSchema, type EdgeInput, type NodeInput } from './schema'

const MAX_EVENTS = 500
const SAVE_DEBOUNCE_MS = 300

function now(): string {
  return new Date().toISOString()
}

export class GraphStore extends EventEmitter {
  private state: GraphState
  private filePath: string
  private eventLogPath: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor(projectRoot: string) {
    super()
    const dir = join(projectRoot, '.claude-manager')
    this.filePath = join(dir, 'graph.json')
    this.eventLogPath = join(dir, 'events.jsonl')
    this.state = this.load(projectRoot)
  }

  private load(projectRoot: string): GraphState {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
        const parsed = graphStateSchema.parse(raw)
        parsed.projectRoot = projectRoot
        return parsed as GraphState
      } catch (err) {
        console.error(`Failed to load ${this.filePath}, starting fresh:`, err)
      }
    }
    return {
      version: 1,
      projectRoot,
      updatedAt: now(),
      nodes: [],
      edges: [],
      events: []
    }
  }

  get(): GraphState {
    return this.state
  }

  upsertNodes(inputs: NodeInput[], termId: string | null): { upserted: string[] } {
    const upserted: string[] = []
    for (const input of inputs) {
      const existing = this.state.nodes.find((n) => n.id === input.id)
      if (existing) {
        if (input.label !== undefined) existing.label = input.label
        if (input.type !== undefined) existing.type = input.type
        if (input.status !== undefined) existing.status = input.status
        if (input.statusNote !== undefined) existing.statusNote = input.statusNote
        if (input.path !== undefined) existing.meta.path = input.path
        if (input.description !== undefined) existing.meta.description = input.description
        if (input.tags !== undefined) existing.meta.tags = input.tags
        if (input.owner !== undefined) existing.meta.owner = input.owner
        delete existing.meta.placeholder
      } else {
        this.state.nodes.push(this.makeNode(input))
      }
      upserted.push(input.id)
    }
    this.commit({
      ts: now(),
      termId,
      tool: 'graph_upsert_nodes',
      summary: `upserted ${upserted.length} node(s): ${upserted.slice(0, 5).join(', ')}${upserted.length > 5 ? '…' : ''}`
    })
    return { upserted }
  }

  upsertEdges(inputs: EdgeInput[], termId: string | null): { upserted: string[] } {
    const upserted: string[] = []
    for (const input of inputs) {
      // auto-create placeholder endpoints so agents can record edges in any order
      for (const endpoint of [input.source, input.target]) {
        if (!this.state.nodes.some((n) => n.id === endpoint)) {
          this.state.nodes.push(
            this.makeNode({ id: endpoint }, { placeholder: true })
          )
        }
      }
      const id = `${input.source}->${input.target}`
      const existing = this.state.edges.find((e) => e.id === id)
      if (existing) {
        if (input.kind !== undefined) existing.kind = input.kind
      } else {
        this.state.edges.push({
          id,
          source: input.source,
          target: input.target,
          kind: input.kind ?? 'lineage'
        })
      }
      upserted.push(id)
    }
    this.commit({
      ts: now(),
      termId,
      tool: 'graph_upsert_edges',
      summary: `upserted ${upserted.length} edge(s)`
    })
    return { upserted }
  }

  setStatus(
    id: string,
    status: GraphNode['status'],
    note: string | undefined,
    termId: string | null
  ): { ok: boolean; error?: string } {
    const node = this.state.nodes.find((n) => n.id === id)
    if (!node) return { ok: false, error: `No node with id "${id}"` }
    node.status = status
    if (note !== undefined) node.statusNote = note
    this.commit({
      ts: now(),
      termId,
      tool: 'graph_set_status',
      summary: `${id} → ${status}${note ? ` (${note.slice(0, 80)})` : ''}`
    })
    return { ok: true }
  }

  /** Set (or clear, with '') a node's owner. Used by the human via the UI and by
   *  agents via graph_upsert_nodes. */
  setOwner(id: string, owner: string, termId: string | null): { ok: boolean; error?: string } {
    const node = this.state.nodes.find((n) => n.id === id)
    if (!node) return { ok: false, error: `No node with id "${id}"` }
    const trimmed = owner.trim()
    if (trimmed) node.meta.owner = trimmed
    else delete node.meta.owner
    this.commit({
      ts: now(),
      termId,
      tool: 'graph_set_owner',
      summary: trimmed ? `${id} owner → ${trimmed}` : `${id} owner cleared`
    })
    return { ok: true }
  }

  remove(nodeIds: string[], edgeIds: string[], termId: string | null): { removed: number } {
    const nodeSet = new Set(nodeIds)
    const edgeSet = new Set(edgeIds)
    const before = this.state.nodes.length + this.state.edges.length
    this.state.nodes = this.state.nodes.filter((n) => !nodeSet.has(n.id))
    // removing a node removes its edges too
    this.state.edges = this.state.edges.filter(
      (e) => !edgeSet.has(e.id) && !nodeSet.has(e.source) && !nodeSet.has(e.target)
    )
    const removed = before - (this.state.nodes.length + this.state.edges.length)
    this.commit({
      ts: now(),
      termId,
      tool: 'graph_remove',
      summary: `removed ${removed} item(s)`
    })
    return { removed }
  }

  setPositions(positions: { id: string; position: { x: number; y: number } }[]): void {
    for (const p of positions) {
      const node = this.state.nodes.find((n) => n.id === p.id)
      if (node) node.position = p.position
    }
    // position tweaks are frequent and cosmetic — persist but don't spam events
    this.state.updatedAt = now()
    this.scheduleSave()
    this.emit('change', { graph: this.state, event: null })
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
    this.removeAllListeners()
  }

  private makeNode(input: NodeInput, meta: GraphNode['meta'] = {}): GraphNode {
    return {
      id: input.id,
      label: input.label ?? input.id,
      type: input.type ?? 'other',
      status: input.status ?? 'unknown',
      statusNote: input.statusNote,
      meta: {
        ...meta,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.owner !== undefined ? { owner: input.owner } : {})
      },
      position: null
    }
  }

  private commit(event: GraphEvent): void {
    this.state.events.push(event)
    if (this.state.events.length > MAX_EVENTS) {
      const overflow = this.state.events.splice(0, this.state.events.length - MAX_EVENTS)
      try {
        appendFileSync(this.eventLogPath, overflow.map((e) => JSON.stringify(e)).join('\n') + '\n')
      } catch {
        // best-effort archive
      }
    }
    this.state.updatedAt = event.ts
    this.scheduleSave()
    this.emit('change', { graph: this.state, event })
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('Failed to save graph.json:', err)
    }
  }
}
