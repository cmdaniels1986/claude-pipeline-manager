export type NodeStatus = 'unknown' | 'in_progress' | 'validated' | 'stale' | 'breaking'
export type NodeType = 'dataset' | 'model' | 'table' | 'source' | 'report' | 'other'
export type EdgeKind = 'lineage' | 'dependency' | 'writes' | 'reads'

export interface GraphNodeMeta {
  path?: string
  description?: string
  tags?: string[]
  placeholder?: boolean
}

export interface GraphNode {
  id: string
  label: string
  type: NodeType
  status: NodeStatus
  statusNote?: string
  meta: GraphNodeMeta
  position: { x: number; y: number } | null
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
}

export interface GraphEvent {
  ts: string
  termId: string | null
  tool: string
  summary: string
}

export interface GraphState {
  version: 1
  projectRoot: string
  updatedAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  events: GraphEvent[]
}

export interface AgentInfo {
  name: string
  description?: string
  model?: string
  tools?: string[]
  source: 'user' | 'project'
  filePath: string
}

export interface TermInfo {
  termId: string
  label: string
  cwd: string
  agentName?: string
  color?: string
  alive: boolean
}

export interface CreateTermOptions {
  cwd: string
  agentName?: string
  model?: string
  color?: string
  cols: number
  rows: number
}

/** tab/agent accent colors offered in the New Terminal dialog */
export const AGENT_COLORS = [
  '#58a6ff',
  '#3fb950',
  '#e3b341',
  '#f0883e',
  '#f85149',
  '#bc8cff',
  '#39c5cf',
  '#ff7b72'
] as const

export interface Diagnostics {
  claudeExePath: string
  claudeVersion: string
  mcpPort: number
  hasAppendSystemPromptFile: boolean
  warnings: string[]
}

export interface GraphChangedPayload {
  graph: GraphState
  event: GraphEvent | null
}

export interface UpdateStatus {
  /** commits behind origin/main; 0 = up to date */
  behind: number
  /** subject line of the newest remote commit */
  latest: string
}
