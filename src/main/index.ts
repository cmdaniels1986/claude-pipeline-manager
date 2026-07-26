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
import { applyUpdate, checkForUpdates, isGitInstall } from './updates/UpdateChecker'
import {
  broadcast,
  closeTerminalWindow,
  createMainWindow,
  getMainWindow,
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

const GRAPH_PROTOCOL = `# Pipeline Graph Protocol

This workspace has a LIVE shared pipeline graph. All Claude sessions collaborate on it
through the "graph" MCP server (tools: graph_get, graph_upsert_nodes, graph_upsert_edges,
graph_remove, graph_set_status). A human watches this graph in real time — keep it current.

Rules:
1. Before working on pipeline code, call graph_get to see the current graph.
2. When you learn pipeline structure (datasets, models, tables, sources and their lineage)
   from reading SQL/dbt/Python ETL code, record it immediately with graph_upsert_nodes and
   graph_upsert_edges. Use stable snake_case ids matching artifact names (e.g. "stg_orders",
   "fct_revenue"). An edge means: source feeds target. Set meta path to the source file.
3. When you START changing a node's code: graph_set_status(id, "in_progress", why).
4. When a change is DONE and verified (tests/build/queries pass): graph_set_status(id,
   "validated", evidence). If your change may invalidate downstream nodes, set each affected
   node to "stale". If something is incompatible/broken, set "breaking" with a note saying
   exactly what breaks.
5. Remove nodes/edges with graph_remove only when the artifact is deleted.
6. Record only lineage you confirmed in code — never guess.
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
    closeTerminalWindow(termId)
  })
  ipcMain.handle('term:list', () => ptyManager.list())

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

  ptyManager = new PtyManager({
    claudeExePath: claudeInfo.exePath,
    hasAppendSystemPromptFile: claudeInfo.hasAppendSystemPromptFile,
    protocolPath,
    settingsFallbackPath,
    writeMcpConfig: (termId) => writeMcpConfigFile(app.getPath('userData'), termId, mcpServer.port),
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
})
