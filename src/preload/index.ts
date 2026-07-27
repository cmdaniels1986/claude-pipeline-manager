import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentInfo,
  CreateTermOptions,
  Diagnostics,
  GraphChangedPayload,
  GraphState,
  TermInfo,
  TermUsage,
  UpdateStatus
} from '../shared/types'

function subscribe<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  // terminals
  termCreate: (opts: CreateTermOptions): Promise<TermInfo> => ipcRenderer.invoke('term:create', opts),
  termInput: (termId: string, data: string): void => ipcRenderer.send('term:input', { termId, data }),
  termResize: (termId: string, cols: number, rows: number): void =>
    ipcRenderer.send('term:resize', { termId, cols, rows }),
  termDispose: (termId: string): Promise<void> => ipcRenderer.invoke('term:dispose', termId),
  termList: (): Promise<TermInfo[]> => ipcRenderer.invoke('term:list'),
  reconcileTerminals: (): Promise<TermInfo[]> => ipcRenderer.invoke('term:reconcile'),
  termClaim: (termId: string): Promise<void> => ipcRenderer.invoke('term:claim', termId),
  termPopout: (opts: { termId: string }): Promise<void> => ipcRenderer.invoke('term:popout', opts),
  onTermData: subscribe<{ termId: string; data: string }>('term:data'),
  onTermExit: subscribe<{ termId: string; exitCode: number }>('term:exit'),
  onTermUsage: subscribe<TermUsage>('term:usage'),
  onTermAdopt: subscribe<{ termId: string; label: string; cwd: string; color?: string }>('term:adopt'),

  // agents
  agentsList: (): Promise<AgentInfo[]> => ipcRenderer.invoke('agents:list'),
  agentsCreateStarter: (name: string): Promise<AgentInfo> => ipcRenderer.invoke('agents:createStarter', name),
  onAgentsChanged: subscribe<null>('agents:changed'),

  // project
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('project:pickFolder'),
  getActiveProject: (): Promise<string | null> => ipcRenderer.invoke('project:getActive'),
  setActiveProject: (root: string): Promise<string> => ipcRenderer.invoke('project:setActive', root),
  onProjectChanged: subscribe<string>('project:changed'),

  // graph
  graphGet: (): Promise<GraphState | null> => ipcRenderer.invoke('graph:get'),
  graphSetPositions: (positions: { id: string; position: { x: number; y: number } }[]): Promise<void> =>
    ipcRenderer.invoke('graph:setPositions', positions),
  openGraphWindow: (): Promise<void> => ipcRenderer.invoke('graph:openWindow'),
  exportGraph: (): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('graph:export'),
  onGraphChanged: subscribe<GraphChangedPayload>('graph:changed'),

  // prompt injection
  promptInject: (opts: { termId: string; text: string; autoSubmit: boolean }): Promise<void> =>
    ipcRenderer.invoke('prompt:inject', opts),

  // node source files
  openFile: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('file:open', path),
  revealFile: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('file:reveal', path),

  // diagnostics
  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke('app:diagnostics'),
  checkLogin: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('app:checkLogin'),

  // updates
  updatesApply: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('updates:apply'),
  onUpdatesAvailable: subscribe<UpdateStatus>('updates:available')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
