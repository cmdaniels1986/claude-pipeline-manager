import { app, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir, userInfo } from 'os'
import { isAbsolute, join } from 'path'
import type { CostSuggestionAction, CostSuggestionKind, CreateTermOptions, Diagnostics, GoalStatus, ProjectInfo, TaskScope, TaskStatus } from '../shared/types'
import { AgentDiscovery } from './agents/AgentDiscovery'
import { GraphStore } from './graph/GraphStore'
import { computeChangedNodes } from './graph/gitScope'
import { GraphMcpServer } from './mcp/GraphMcpServer'
import { writeMcpConfigFile } from './mcp/writeMcpConfig'
import { ProjectManager } from './projects/ProjectManager'
import { ActivityMonitor } from './pty/activityDetect'
import { PtyManager } from './pty/PtyManager'
import { prunePastedImages, savePastedImage } from './images/pasteStore'
import { TaskHub } from './tasks/TaskHub'
import { checkLogin, detectClaude, type ClaudeInfo } from './pty/resolveClaude'
import { exportGraphHtml } from './export/exportGraphHtml'
import { applyUpdate, checkForUpdates, checkForUpdatesDetailed, isGitInstall } from './updates/UpdateChecker'
import { ResumeManager } from './usage/ResumeManager'
import { UsageTracker } from './usage/UsageTracker'
import { CostAdvisor } from './usage/CostAdvisor'
import { ContextStore } from './context/ContextStore'
import { scanMemoryBanks } from './memoryScan'
import { buildUserMemoryBlock } from './userMemory'
import {
  broadcast,
  closeTerminalWindow,
  createMainWindow,
  getMainWindow,
  isTerminalPoppedOut,
  openGraphWindow,
  openTerminalWindow
} from './windows'

if (!app.isPackaged) {
  // dev-only: allows driving the renderer over CDP for automated verification
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// A failed ConPTY spawn (e.g. bad cwd) surfaces as an async uncaught exception from
// node-pty; without this handler Electron shows a blocking native error dialog that
// freezes the whole app. Log and keep running instead.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
})

const GRAPH_PROTOCOL = `# Pipeline Graph
A live shared pipeline graph is visible to a human in real time; keep it current via the "graph" MCP tools. Don't over-report — a few tool calls at natural checkpoints, not after every step.
- After reading pipeline code (SQL/dbt/Python ETL), record datasets + lineage: graph_upsert_nodes (stable snake_case ids matching artifact names; set path) and graph_upsert_edges (source feeds target). Record only lineage you confirmed in code.
- graph_set_status: in_progress when you start changing a node; validated (with evidence) when done; stale for downstream nodes a change may invalidate; breaking (say what breaks) when incompatible.
- graph_remove only when an artifact is deleted. Call graph_get (compact) if you need the current graph.

# Goals & Tasks
A human sees a live goals/tasks board (shared with you via the "graph" MCP server's task_* tools). Keep it current so they can follow your progress.
- When you take on a multi-step piece of work, capture it: tasks_add_goal (an objective, optionally with an initial task list) and tasks_add_tasks (more tasks under a goal).
- tasks_set_status as you go: doing when you start a task, done when it's finished. This is the main signal the human watches — keep it honest. Passing a goal id (with done) marks the whole goal complete once its objective is met.
- tasks_get to see the current board; tasks_remove only when an item is genuinely no longer relevant. The human also edits this board, so don't wipe their entries.
`

let claudeInfo: ClaudeInfo
let ptyManager: PtyManager
let resumeManager: ResumeManager
let activityMonitor: ActivityMonitor | null = null
let mcpServer: GraphMcpServer
/** which renderer window currently hosts each terminal's UI */
const termHosts = new Map<string, Electron.WebContents>()

function sendToTermHost(termId: string, channel: string, payload: unknown): void {
  const host = termHosts.get(termId)
  if (host && !host.isDestroyed()) {
    host.send(channel, payload)
  } else {
    getMainWindow()?.webContents.send(channel, payload)
  }
}
const agentDiscovery = new AgentDiscovery()
let usageTracker: UsageTracker
let costAdvisor: CostAdvisor
let graphStore: GraphStore | null = null
let taskHub: TaskHub | null = null
/** shared context notes, only when the active project has a shared folder */
let contextStore: ContextStore | null = null
let projectManager: ProjectManager
let activeProject: string | null = null
const startupWarnings: string[] = []

function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

/** display name stamped on this machine's task edits (shows on a shared list) */
function taskAuthorName(): string {
  try {
    return userInfo().username || 'me'
  } catch {
    return 'me'
  }
}

/** Build the two-list task hub for a project (a local "My Goals" store plus,
 *  when a shared folder is set, a synced "Shared Goals" store), wired to
 *  broadcast changes + conflict warnings to the renderer. */
function makeTaskHub(info: ProjectInfo): TaskHub {
  return new TaskHub({
    projectRoot: info.root,
    sharedPath: info.sharedTasksPath ?? null,
    author: taskAuthorName(),
    onChange: (payload) => broadcast('tasks:changed', payload),
    onWarning: (w) => broadcast('tasks:warning', w)
  })
}

/** The active project's shared folder, or null when it isn't shared. */
function activeSharedPath(): string | null {
  const active = projectManager?.list().find((p) => p.id === projectManager.activeId())
  return active?.sharedTasksPath ?? null
}

/** Snapshot pushed to the renderer's shared-context view. */
function contextSnapshot(sharedPath: string | null): { sharedPath: string | null; posts: ReturnType<ContextStore['get']> } {
  return { sharedPath, posts: contextStore?.get() ?? [] }
}

/** (Re)build the shared-context store for a project: present only when the
 *  project has a shared folder, since context is for coworkers on the same one. */
function rebuildContextStore(sharedPath: string | null): void {
  contextStore?.dispose()
  contextStore = null
  if (sharedPath) {
    contextStore = new ContextStore(sharedPath, taskAuthorName())
    contextStore.on('change', () => broadcast('context:changed', contextSnapshot(sharedPath)))
  }
  broadcast('context:changed', contextSnapshot(sharedPath))
}

function setActiveProject(info: ProjectInfo): void {
  if (activeProject === info.root) return
  graphStore?.dispose()
  taskHub?.dispose()
  activeProject = info.root
  graphStore = new GraphStore(info.root)
  graphStore.on('change', (payload) => broadcast('graph:changed', payload))
  taskHub = makeTaskHub(info)
  rebuildContextStore(info.sharedTasksPath ?? null)
  agentDiscovery.setProjectRoot(info.root)
  broadcast('graph:changed', { graph: graphStore.get(), event: null })
  broadcast('tasks:changed', { ...taskHub.snapshot(), event: null, scope: null })
}

function broadcastProjects(): void {
  broadcast('projects:changed', { projects: projectManager.list(), activeId: projectManager.activeId() })
}

function collectWarnings(): void {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
      if (settings?.hooks?.UserPromptSubmit) {
        startupWarnings.push(
          'Your global ~/.claude/settings.json has a UserPromptSubmit hook (UE screenshot capture). ' +
            'It will run on every prompt in every terminal here, adding latency. Consider moving it ' +
            "into the Unreal project's .claude/settings.json."
        )
      }
    }
  } catch {
    // unreadable settings — nothing to warn about
  }
}

/** Graph protocol + the user's cross-project memory index, so every spawned
 *  session starts with the same context as opening Claude normally. */
function buildProtocolContent(): string {
  const memory = buildUserMemoryBlock()
  return memory ? `${GRAPH_PROTOCOL}\n${memory}\n` : GRAPH_PROTOCOL
}

const protocolFilePath = (): string => userDataPath('graph-protocol.md')

/** Rewrites the protocol file with the current user memory. Called before each
 *  spawn so long-running app sessions pick up memory edits made since launch. */
function refreshProtocolFile(): void {
  writeFileSync(protocolFilePath(), buildProtocolContent())
}

function writeSupportFiles(): { protocolPath: string; settingsFallbackPath: string } {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const protocolPath = protocolFilePath()
  writeFileSync(protocolPath, buildProtocolContent())
  // Fallback for CLIs without --append-system-prompt-file: a SessionStart hook that
  // emits the protocol into context.
  const settingsFallbackPath = userDataPath('session-settings.json')
  writeFileSync(
    settingsFallbackPath,
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `cmd /c type "${protocolPath}"` }] }
          ]
        }
      },
      null,
      2
    )
  )
  return { protocolPath, settingsFallbackPath }
}

function registerIpc(): void {
  // clear out last week's pasted screenshots so ~/.claude/pasted-images can't grow forever
  prunePastedImages()
  ipcMain.handle('term:create', (e, opts: CreateTermOptions) => {
    let isDir = false
    try {
      isDir = statSync(opts.cwd).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) throw new Error(`Working folder does not exist: ${opts.cwd}`)
    refreshProtocolFile()
    const info = ptyManager.create(opts)
    termHosts.set(info.termId, e.sender)
    usageTracker.track(info.termId)
    return info
  })
  ipcMain.handle('term:claim', (e, termId: string) => {
    termHosts.set(termId, e.sender)
  })
  ipcMain.handle('term:popout', (_e, { termId }: { termId: string }) => {
    const info = ptyManager.list().find((t) => t.termId === termId)
    if (!info?.alive) throw new Error('Terminal is not running')
    openTerminalWindow(termId, info.label, info.cwd, info.color, () => {
      // window closed: if the session is still alive, hand it back to the main
      // window as a tab instead of killing it
      const current = ptyManager.list().find((t) => t.termId === termId)
      if (!current?.alive) return
      const main = getMainWindow()
      if (main && !main.isDestroyed()) {
        termHosts.set(termId, main.webContents)
        main.webContents.send('term:adopt', {
          termId,
          label: current.label,
          cwd: current.cwd,
          color: current.color
        })
      } else {
        ptyManager.dispose(termId)
      }
    })
  })
  ipcMain.on('term:input', (_e, { termId, data }: { termId: string; data: string }) => {
    ptyManager.write(termId, data)
  })
  // Terminals only carry text, so a clipboard image never reaches the Claude CLI.
  // The renderer hands us the raw bytes; we spill them to a file and type the path
  // into the session — the same thing Claude Code's drag-and-drop does.
  ipcMain.handle(
    'term:pasteImage',
    (_e, { termId, bytes, mime }: { termId: string; bytes: Uint8Array; mime: string }) => {
      if (!ptyManager.isAlive(termId)) return { ok: false as const, error: 'Terminal is not running' }
      try {
        const { path, fileName } = savePastedImage(bytes, mime)
        // match Claude Code's drag-drop: only quote when the path contains whitespace
        const token = /\s/.test(path) ? `"${path}"` : path
        ptyManager.write(termId, `${token} `)
        return { ok: true as const, path, fileName }
      } catch (err) {
        return { ok: false as const, error: String(err) }
      }
    }
  )
  ipcMain.on('term:resize', (_e, { termId, cols, rows }: { termId: string; cols: number; rows: number }) => {
    ptyManager.resize(termId, cols, rows)
  })
  ipcMain.handle('term:dispose', (_e, termId: string) => {
    ptyManager.dispose(termId)
    resumeManager.dispose(termId)
    termHosts.delete(termId)
    usageTracker.untrack(termId)
    costAdvisor.untrack(termId)
    closeTerminalWindow(termId)
  })
  ipcMain.handle('term:setLabel', (_e, { termId, label }: { termId: string; label: string }) => {
    ptyManager.setLabel(termId, label)
  })
  ipcMain.handle('term:setColor', (_e, { termId, color }: { termId: string; color: string | null }) => {
    ptyManager.setColor(termId, color)
  })
  ipcMain.handle('term:list', () => ptyManager.list())
  // live terminals the main window should re-adopt after a renderer reload
  // (idle/sleep can reload the dev page); excludes ones hosted in a pop-out window
  ipcMain.handle('term:reconcile', () =>
    ptyManager.list().filter((t) => t.alive && !isTerminalPoppedOut(t.termId))
  )

  ipcMain.handle('agents:list', () => agentDiscovery.list())
  ipcMain.handle('agents:createStarter', (_e, name: string) => agentDiscovery.createStarter(name))

  ipcMain.handle('project:list', () => ({
    projects: projectManager.list(),
    activeId: projectManager.activeId()
  }))
  ipcMain.handle('project:getActive', () => projectManager.getActive())
  ipcMain.handle('project:create', (_e, name: string) => {
    const info = projectManager.create(name)
    setActiveProject(info)
    broadcastProjects()
    return info
  })
  ipcMain.handle('project:switch', (_e, id: string) => {
    const info = projectManager.setActive(id)
    if (info) {
      setActiveProject(info)
      broadcastProjects()
    }
    return info
  })
  ipcMain.handle('project:rename', (_e, { id, name }: { id: string; name: string }) => {
    projectManager.rename(id, name)
    broadcastProjects()
  })
  ipcMain.handle('project:remove', (_e, id: string) => {
    projectManager.remove(id)
    // keep an active project alive at all times
    const active = projectManager.ensureDefault()
    setActiveProject(active)
    broadcastProjects()
    return { projects: projectManager.list(), activeId: projectManager.activeId() }
  })

  // ---- shared task list (cloud-synced folder) ------------------------------
  ipcMain.handle('project:pickSharedFolder', async () => {
    const win = getMainWindow()
    const opts = {
      title: 'Choose a synced folder to share tasks through',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const }
    return { canceled: false as const, path: result.filePaths[0] }
  })
  ipcMain.handle(
    'project:setShared',
    (_e, { id, folderPath }: { id: string; folderPath: string | null }) => {
      const before = projectManager.list().find((p) => p.id === id)
      if (!before) return null
      if (projectManager.activeId() === id && taskHub) {
        // turn the shared "Shared Goals" list on/off live (existing goals stay
        // put; unsharing copies shared goals back into the private list)
        projectManager.setSharedTasksPath(id, folderPath)
        taskHub.setSharedPath(folderPath)
        rebuildContextStore(folderPath)
        broadcast('tasks:changed', { ...taskHub.snapshot(), event: null, scope: null })
      } else {
        // apply the same transition off to the side for a non-active project
        const tmp = new TaskHub({
          projectRoot: before.root,
          sharedPath: before.sharedTasksPath ?? null,
          author: taskAuthorName(),
          onChange: () => {},
          onWarning: () => {}
        })
        tmp.setSharedPath(folderPath)
        tmp.dispose()
        projectManager.setSharedTasksPath(id, folderPath)
      }
      broadcastProjects()
      return projectManager.list().find((p) => p.id === id) ?? null
    }
  )
  ipcMain.handle('project:revealShared', (_e, folderPath: string) => {
    if (folderPath) void shell.openPath(folderPath)
  })

  ipcMain.handle('graph:get', () => graphStore?.get() ?? null)
  ipcMain.handle('graph:setPositions', (_e, positions: { id: string; position: { x: number; y: number } }[]) => {
    graphStore?.setPositions(positions)
  })
  ipcMain.handle('graph:openWindow', () => {
    openGraphWindow()
  })
  ipcMain.handle('graph:setOwner', (_e, { id, owner }: { id: string; owner: string }) => {
    graphStore?.setOwner(id, owner, null)
  })
  // scope the graph to git changes — best-effort, local, no tokens
  ipcMain.handle('graph:changedNodes', () =>
    graphStore
      ? computeChangedNodes(graphStore.get().nodes)
      : { changed: [], branch: null, repos: 0, reason: 'No active project.' }
  )
  ipcMain.handle('graph:export', async () => {
    if (!graphStore) return { ok: false, error: 'No active project.' }
    const graph = graphStore.get()
    if (!graph.nodes.length) return { ok: false, error: 'The graph is empty — nothing to export yet.' }
    const name = (graph.projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'pipeline') + '-pipeline.html'
    const win = getMainWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'HTML', extensions: ['html'] }] })
      : await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: 'HTML', extensions: ['html'] }] })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    writeFileSync(result.filePath, exportGraphHtml(graph))
    shell.showItemInFolder(result.filePath)
    return { ok: true, path: result.filePath }
  })

  // goals & tasks — human edits from the UI (termId null = "you"); agents use the
  // task_* MCP tools. Both funnel through the TaskHub, which routes each edit to
  // the private ("mine") or shared list that holds the goal/task.
  ipcMain.handle('tasks:get', () => taskHub?.snapshot() ?? null)
  ipcMain.handle('tasks:addGoal', (_e, p: { title: string; note?: string; scope?: TaskScope }) =>
    taskHub?.addGoal({ title: p.title, note: p.note }, null, p.scope ?? 'mine')
  )
  ipcMain.handle('tasks:updateGoal', (_e, p: { goalId: string; title?: string; note?: string; status?: GoalStatus }) =>
    taskHub?.updateGoal(p.goalId, { title: p.title, note: p.note, status: p.status }, null)
  )
  ipcMain.handle('tasks:addTask', (_e, p: { goalId: string; title: string }) =>
    taskHub?.addTasks(p.goalId, [p.title], null)
  )
  ipcMain.handle(
    'tasks:updateTask',
    (_e, p: { taskId: string; title?: string; status?: TaskStatus; note?: string }) =>
      taskHub?.updateTask(p.taskId, { title: p.title, status: p.status, note: p.note }, null)
  )
  ipcMain.handle('tasks:remove', (_e, ids: string[]) => taskHub?.remove(ids, null))
  ipcMain.handle('tasks:moveGoal', (_e, p: { goalId: string; scope: TaskScope }) =>
    taskHub?.moveGoal(p.goalId, p.scope, null)
  )

  // shared context — coworker notes posted into the project's shared folder.
  // Only functional when the active project has a shared location (contextStore
  // is null otherwise, so post/remove are safe no-ops).
  ipcMain.handle('context:get', () => contextSnapshot(contextStore ? activeSharedPath() : null))
  ipcMain.handle('context:post', (_e, p: { text: string; taskId?: string; taskTitle?: string }) => {
    if (!contextStore || !p.text?.trim()) return { ok: false }
    contextStore.post({ text: p.text, taskId: p.taskId, taskTitle: p.taskTitle })
    return { ok: true }
  })
  ipcMain.handle('context:remove', (_e, id: string) => {
    contextStore?.remove(id)
    return { ok: true }
  })

  // Prompts are queued (not sent raw), so they auto-resume after a usage limit.
  // When usage is available the queue drains immediately, matching the old behavior.
  ipcMain.handle('prompt:inject', (_e, { termId, text }: { termId: string; text: string }) => {
    resumeManager.enqueue(termId, text)
  })
  ipcMain.handle('resume:get', () => resumeManager.states())
  ipcMain.handle('resume:now', (_e, termId: string) => resumeManager.resumeNow(termId))
  ipcMain.handle('resume:cancel', (_e, termId: string) => resumeManager.cancel(termId))

  // cost advisor — dismiss a suggestion, or apply its one-click fix
  ipcMain.handle('advisor:dismiss', (_e, { termId, kind }: { termId: string; kind: CostSuggestionKind }) => {
    costAdvisor.dismiss(termId, kind)
  })
  ipcMain.handle(
    'advisor:apply',
    (_e, { termId, action }: { termId: string; action: CostSuggestionAction }) => {
      if (action?.kind === 'inject_clear') {
        if (!ptyManager.isAlive(termId)) return { ok: false as const, error: 'Terminal is not running' }
        // type `/clear` into the session and submit — resets an over-large context
        ptyManager.injectPrompt(termId, '/clear', true)
        return { ok: true as const }
      }
      if (action?.kind === 'set_model') {
        if (!ptyManager.isAlive(termId)) return { ok: false as const, error: 'Terminal is not running' }
        const model = (action.model ?? '').trim()
        if (!model) return { ok: false as const, error: 'No model specified' }
        // type `/model <model>` and submit — switches this session to a cheaper tier
        ptyManager.injectPrompt(termId, `/model ${model}`, true)
        return { ok: true as const }
      }
      return { ok: false as const, error: 'Unknown action' }
    }
  )

  // startup memory check — confirm the user's cross-project memory is found and
  // will be injected into terminals (surfaces the otherwise-silent injection)
  ipcMain.handle('memory:scan', () => scanMemoryBanks())

  ipcMain.handle('app:diagnostics', (): Diagnostics => {
    return {
      claudeExePath: claudeInfo.exePath,
      claudeVersion: claudeInfo.version,
      mcpPort: mcpServer.port,
      hasAppendSystemPromptFile: claudeInfo.hasAppendSystemPromptFile,
      apiKeyBilling: !!process.env.ANTHROPIC_API_KEY,
      warnings: startupWarnings
    }
  })

  const resolveNodePath = (relOrAbs: string): string | null => {
    if (!relOrAbs) return null
    const full = isAbsolute(relOrAbs) ? relOrAbs : activeProject ? join(activeProject, relOrAbs) : relOrAbs
    return existsSync(full) ? full : null
  }

  ipcMain.handle('file:open', async (_e, path: string) => {
    const full = resolveNodePath(path)
    if (!full) return { ok: false, error: `File not found: ${path} (renamed or deleted?)` }
    const err = await shell.openPath(full)
    return err ? { ok: false, error: err } : { ok: true }
  })
  ipcMain.handle('file:reveal', (_e, path: string) => {
    const full = resolveNodePath(path)
    if (!full) return { ok: false, error: `File not found: ${path} (renamed or deleted?)` }
    shell.showItemInFolder(full)
    return { ok: true }
  })

  ipcMain.handle('app:checkLogin', () => checkLogin(claudeInfo.exePath))

  ipcMain.handle('updates:check', () => checkForUpdatesDetailed(app.getAppPath()))

  ipcMain.handle('updates:apply', async () => {
    const result = await applyUpdate(app.getAppPath())
    if (result.ok) {
      // give the renderer a beat to show the restarting state, then exit; the
      // launcher .bat sees the restart marker and boots the updated app
      setTimeout(() => app.exit(0), 800)
    }
    return result
  })
}

function startUpdateChecks(): void {
  const root = app.getAppPath()
  if (!isGitInstall(root)) return
  const check = async (): Promise<void> => {
    const status = await checkForUpdates(root)
    if (status && status.behind > 0) broadcast('updates:available', status)
  }
  void check()
  setInterval(() => void check(), 30 * 60 * 1000)
}

app.whenReady().then(async () => {
  try {
    claudeInfo = await detectClaude()
  } catch (err) {
    dialog.showErrorBox('Claude Code CLI not found', String(err))
    app.quit()
    return
  }

  collectWarnings()
  const { protocolPath, settingsFallbackPath } = writeSupportFiles()

  mcpServer = new GraphMcpServer(
    () => graphStore,
    () => taskHub
  )
  await mcpServer.start()

  costAdvisor = new CostAdvisor((termId, suggestions) =>
    sendToTermHost(termId, 'advisor:changed', { termId, suggestions })
  )
  usageTracker = new UsageTracker((usage) => {
    sendToTermHost(usage.termId, 'term:usage', usage)
    // feed the same telemetry into the cost advisor (subscription vs API framing
    // comes from whether an API key is set)
    costAdvisor.record(usage, Date.now(), !!process.env.ANTHROPIC_API_KEY)
  })
  await usageTracker.start()

  ptyManager = new PtyManager({
    claudeExePath: claudeInfo.exePath,
    hasAppendSystemPromptFile: claudeInfo.hasAppendSystemPromptFile,
    protocolPath,
    settingsFallbackPath,
    writeMcpConfig: (termId) => writeMcpConfigFile(app.getPath('userData'), termId, mcpServer.port),
    usageEnv: () => usageTracker.envFor(),
    onData: (termId, data) => {
      sendToTermHost(termId, 'term:data', { termId, data })
      resumeManager?.observe(termId, data)
      activityMonitor?.observe(termId, data)
    },
    onExit: (termId, exitCode) => {
      sendToTermHost(termId, 'term:exit', { termId, exitCode })
      resumeManager?.onExit(termId)
      activityMonitor?.end(termId)
    }
  })

  // glanceable "Claude is working here" state for each tab, scraped from the
  // TUI's "esc to interrupt" hint (see activityDetect.ts)
  activityMonitor = new ActivityMonitor({
    onChange: (termId, busy) => broadcast('term:activity', { termId, busy })
  })

  resumeManager = new ResumeManager({
    inject: (termId, text) => ptyManager.injectPrompt(termId, text, true),
    relaunchResume: (termId) => ptyManager.relaunchResume(termId),
    isAlive: (termId) => ptyManager.isAlive(termId),
    onState: (state) => broadcast('resume:changed', state),
    onResumed: (termId) => sendToTermHost(termId, 'term:resumed', termId)
  })

  agentDiscovery.on('changed', () => broadcast('agents:changed', null))

  // app-managed project library — always open one so the graph/tasks have a home
  projectManager = new ProjectManager(app.getPath('userData'))
  const active = projectManager.ensureDefault()
  setActiveProject(active)

  registerIpc()
  createMainWindow()
  startUpdateChecks()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  ptyManager?.disposeAll()
  resumeManager?.disposeAll()
  activityMonitor?.dispose()
  graphStore?.dispose()
  taskHub?.dispose()
  contextStore?.dispose()
  mcpServer?.stop()
  agentDiscovery.dispose()
  usageTracker?.dispose()
})
