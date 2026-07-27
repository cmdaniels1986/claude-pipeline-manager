import { app, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import type { CreateTermOptions, Diagnostics } from '../shared/types'
import { AgentDiscovery } from './agents/AgentDiscovery'
import { GraphStore } from './graph/GraphStore'
import { GraphMcpServer } from './mcp/GraphMcpServer'
import { writeMcpConfigFile } from './mcp/writeMcpConfig'
import { PtyManager } from './pty/PtyManager'
import { checkLogin, detectClaude, type ClaudeInfo } from './pty/resolveClaude'
import { exportGraphHtml } from './export/exportGraphHtml'
import { applyUpdate, checkForUpdates, checkForUpdatesDetailed, isGitInstall } from './updates/UpdateChecker'
import { UsageTracker } from './usage/UsageTracker'
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
`

let claudeInfo: ClaudeInfo
let ptyManager: PtyManager
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
let graphStore: GraphStore | null = null
let activeProject: string | null = null
const startupWarnings: string[] = []

function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

function setActiveProject(root: string): void {
  if (activeProject === root) return
  graphStore?.dispose()
  activeProject = root
  graphStore = new GraphStore(root)
  graphStore.on('change', (payload) => broadcast('graph:changed', payload))
  agentDiscovery.setProjectRoot(root)
  broadcast('project:changed', root)
  broadcast('graph:changed', { graph: graphStore.get(), event: null })
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

function writeSupportFiles(): { protocolPath: string; settingsFallbackPath: string } {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const protocolPath = userDataPath('graph-protocol.md')
  writeFileSync(protocolPath, GRAPH_PROTOCOL)
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
  ipcMain.handle('term:create', (e, opts: CreateTermOptions) => {
    let isDir = false
    try {
      isDir = statSync(opts.cwd).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) throw new Error(`Working folder does not exist: ${opts.cwd}`)
    if (!activeProject) setActiveProject(opts.cwd)
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
  ipcMain.on('term:resize', (_e, { termId, cols, rows }: { termId: string; cols: number; rows: number }) => {
    ptyManager.resize(termId, cols, rows)
  })
  ipcMain.handle('term:dispose', (_e, termId: string) => {
    ptyManager.dispose(termId)
    termHosts.delete(termId)
    usageTracker.untrack(termId)
    closeTerminalWindow(termId)
  })
  ipcMain.handle('term:list', () => ptyManager.list())
  // live terminals the main window should re-adopt after a renderer reload
  // (idle/sleep can reload the dev page); excludes ones hosted in a pop-out window
  ipcMain.handle('term:reconcile', () =>
    ptyManager.list().filter((t) => t.alive && !isTerminalPoppedOut(t.termId))
  )

  ipcMain.handle('agents:list', () => agentDiscovery.list())
  ipcMain.handle('agents:createStarter', (_e, name: string) => agentDiscovery.createStarter(name))

  ipcMain.handle('project:pickFolder', async () => {
    const win = getMainWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('project:getActive', () => activeProject)
  ipcMain.handle('project:setActive', (_e, root: string) => {
    setActiveProject(root)
    return activeProject
  })

  ipcMain.handle('graph:get', () => graphStore?.get() ?? null)
  ipcMain.handle('graph:setPositions', (_e, positions: { id: string; position: { x: number; y: number } }[]) => {
    graphStore?.setPositions(positions)
  })
  ipcMain.handle('graph:openWindow', () => {
    openGraphWindow()
  })
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

  ipcMain.handle(
    'prompt:inject',
    (_e, { termId, text, autoSubmit }: { termId: string; text: string; autoSubmit: boolean }) => {
      ptyManager.injectPrompt(termId, text, autoSubmit)
    }
  )

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

  mcpServer = new GraphMcpServer(() => graphStore)
  await mcpServer.start()

  usageTracker = new UsageTracker((usage) => sendToTermHost(usage.termId, 'term:usage', usage))
  await usageTracker.start()

  ptyManager = new PtyManager({
    claudeExePath: claudeInfo.exePath,
    hasAppendSystemPromptFile: claudeInfo.hasAppendSystemPromptFile,
    protocolPath,
    settingsFallbackPath,
    writeMcpConfig: (termId) => writeMcpConfigFile(app.getPath('userData'), termId, mcpServer.port),
    usageEnv: () => usageTracker.envFor(),
    onData: (termId, data) => sendToTermHost(termId, 'term:data', { termId, data }),
    onExit: (termId, exitCode) => sendToTermHost(termId, 'term:exit', { termId, exitCode })
  })

  agentDiscovery.on('changed', () => broadcast('agents:changed', null))

  registerIpc()
  createMainWindow()
  startUpdateChecks()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  ptyManager?.disposeAll()
  graphStore?.dispose()
  mcpServer?.stop()
  agentDiscovery.dispose()
  usageTracker?.dispose()
})
