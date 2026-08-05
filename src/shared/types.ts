export type NodeStatus = 'unknown' | 'in_progress' | 'validated' | 'stale' | 'breaking'
export type NodeType = 'dataset' | 'model' | 'table' | 'source' | 'report' | 'other'
export type EdgeKind = 'lineage' | 'dependency' | 'writes' | 'reads'

export interface GraphNodeMeta {
  path?: string
  description?: string
  tags?: string[]
  /** who owns this artifact (a name/team) — human- or agent-set, searchable */
  owner?: string
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
/** whether a whole goal has been completed */
export type GoalStatus = 'active' | 'done'

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
  /** 'done' when the human/agent has marked the whole goal complete */
  status: GoalStatus
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

/** which of a project's two lists an edit / goal belongs to */
export type TaskScope = 'mine' | 'shared'

/** the full two-list view of the active project's tasks */
export interface TasksSnapshot {
  /** private to this machine's app (My Goals) */
  mine: TasksState
  /** synced with a coworker (Shared Goals); null when no shared folder is set */
  shared: TasksState | null
  /** the shared folder, when configured */
  sharedPath: string | null
}

export interface TasksChangedPayload extends TasksSnapshot {
  event: TaskEvent | null
  /** which list the event came from */
  scope: TaskScope | null
}

/** surfaced when a cloud drive creates a "conflicted copy" beside the shared file */
export interface TasksWarning {
  projectRoot: string
  message: string
}

// ---- shared context (coworkers on the same project) -----------------------
/** A note a coworker posts to the project's shared folder so others picking up
 *  the work have the background — optionally tied to the shared task it's about. */
export interface ContextPost {
  id: string
  /** display name of whoever posted it (this machine's user) */
  author: string
  ts: string
  text: string
  /** the shared task this context is about, when posted from the "working on it" prompt */
  taskId?: string
  taskTitle?: string
}

export interface ContextState {
  version: 1
  updatedAt: string
  posts: ContextPost[]
  /** deleted post ids, so a removal propagates across the shared file */
  removed?: { id: string; ts: string }[]
}

/** the shared-context view for the active project */
export interface ContextSnapshot {
  /** the shared folder path, or null when this project has no shared location */
  sharedPath: string | null
  posts: ContextPost[]
}

export type ContextChangedPayload = ContextSnapshot

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

// ---- startup memory check -------------------------------------------------
/** One Claude Code auto-memory store found under the config dir. */
export interface MemoryBank {
  /** the encoded project-folder name, e.g. "C--Users-cmdan" */
  key: string
  /** absolute path to the store's memory/ folder */
  dir: string
  /** number of "- [Title](file)" entries in its MEMORY.md index */
  entries: number
  /** number of memory .md files besides MEMORY.md */
  files: number
  /** the first few entry titles, so the user can recognize their own memory */
  sampleTitles: string[]
  /** true for the user-level ("all projects") store the app injects into terminals */
  active: boolean
  /** true when it has a readable, non-empty MEMORY.md */
  hasIndex: boolean
}

/** Result of scanning every known memory bank at startup. */
export interface MemoryScan {
  /** the config dir searched (honors CLAUDE_CONFIG_DIR) */
  configDir: string
  /** every memory bank found, active one first */
  banks: MemoryBank[]
  /** the user-level store that gets injected, if present + non-empty */
  active: MemoryBank | null
  /** true when the active cross-project memory was found and will be injected */
  ok: boolean
  /** why the check failed / what to do, when !ok */
  reason?: string
}

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

/** result of scoping the graph to files changed in the working tree / branch */
export interface ChangedNodesResult {
  /** node ids whose source file is modified in a git repo */
  changed: string[]
  /** current branch name (of the first repo found), if determinable */
  branch: string | null
  /** how many distinct git repos the node source files span */
  repos: number
  /** set when git couldn't run or no node had a resolvable source file */
  reason?: string
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
