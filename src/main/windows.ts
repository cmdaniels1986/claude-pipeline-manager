import { BrowserWindow, shell } from 'electron'
import { join } from 'path'

let mainWindow: BrowserWindow | null = null
let graphWindow: BrowserWindow | null = null

function baseOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  }
}

function loadRenderer(win: BrowserWindow, hash: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({ ...baseOptions(), width: 1500, height: 950, title: 'Claude Pipeline Manager' })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  loadRenderer(mainWindow, '')
  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function openGraphWindow(): BrowserWindow {
  if (graphWindow && !graphWindow.isDestroyed()) {
    graphWindow.focus()
    return graphWindow
  }
  graphWindow = new BrowserWindow({ ...baseOptions(), width: 1200, height: 850, title: 'Pipeline Graph' })
  graphWindow.on('ready-to-show', () => graphWindow?.show())
  graphWindow.on('closed', () => {
    graphWindow = null
  })
  loadRenderer(graphWindow, '/graph')
  return graphWindow
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
