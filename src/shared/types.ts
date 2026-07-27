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

// ---- projects (app-managed workspaces) ------------------------------------
export interface ProjectInfo {
  id: string
  name: string
  /** absolute path to this project's folder under the app's user-data dir */
  root: string
  createdAt: string
  lastOpenedAt: string
  /** when set, the goals & tasks live in <sharedTasksPath>/tasks.json in a
   *  cloud-synced folder (OneDrive/Google Drive/Dropbox) shared with a coworker,
   *  instead of the local app-data root. */
  sharedTasksPath?: string
}

export interface ProjectsState {
  projects: ProjectInfo[]
  activeId: string | null
}

// ---- usage-limit auto-resume ----------------------------------------------
export interface ResumeState {
  termId: string
  /** true while waiting for a hit usage limit to reset */
  limited: boolean
  /** epoch ms when the limit resets, or null if unknown */
  resetAt: number | null
  /** human-readable reset description, e.g. "session limit · resets 3:45pm (America/New_York)" */
  resetLabel: string | null
  /** prompts waiting to be sent, in order (drained when usage is available) */
  queue: string[]
}

// ---- goals & tasks --------------------------------------------------------
export type TaskStatus = 'todo' | 'doing' | 'done'

export interface Task {
  id: string
  title: string
  status: TaskStatus
  note?: string
  createdAt: string
  updatedAt: string
  /** who last touched this task — a coworker's name or "agent" (shared lists) */
  updatedBy?: string
}

export interface Goal {
  id: string
  title: string
  note?: string
  tasks: Task[]
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

export interface TaskEvent {
  ts: string
  /** the terminal that made the change; null = edited by the human in the UI */
  termId: string | null
  tool: string
  summary: string
  /** display name of whoever made the change (this machine's user, on a shared list) */
  by?: string
}

/** A deleted goal/task id, kept so a removal propagates across a shared file
 *  instead of the item resurrecting on the next merge. */
export interface TaskTombstone {
  id: string
  ts: string
}

export interface TasksState {
  version: 1
  projectRoot: string
  updatedAt: string
  goals: Goal[]
  events: TaskEvent[]
  removed?: TaskTombstone[]
}

export interface TasksChangedPayload {
  tasks: TasksState
  event: TaskEvent | null
}

/** surfaced when a cloud drive creates a "conflicted copy" beside the shared file */
export interface TasksWarning {
  projectRoot: string
  message: string
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
  /** launch with --dangerously-skip-permissions (no permission prompts) */
  dangerous?: boolean
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
  /** ANTHROPIC_API_KEY present → sessions bill per-token (real $); else subscription (notional) */
  apiKeyBilling: boolean
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

/** result of a manual update check — surfaces why a check couldn't run */
export interface UpdateCheckResult {
  ok: boolean
  behind?: number
  latest?: string
  reason?: string
}

export interface TermUsage {
  termId: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /** total context size of the most recent turn (input + cache + output), ~how full the window is */
  contextTokens: number
  messages: number
  /** estimated USD; null when the model's pricing is unknown */
  costUsd: number | null
}
