import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentInfo,
  CreateTermOptions,
  Diagnostics,
  GraphChangedPayload,
  GraphState,
  ProjectInfo,
  ProjectsState,
  ResumeState,
  TaskStatus,
  TasksChangedPayload,
  TasksState,
  TermInfo,
  TermUsage,
  UpdateCheckResult,
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
  onTermResumed: subscribe<string>('term:resumed'),

  // agents
  agentsList: (): Promise<AgentInfo[]> => ipcRenderer.invoke('agents:list'),
  agentsCreateStarter: (name: string): Promise<AgentInfo> => ipcRenderer.invoke('agents:createStarter', name),
  onAgentsChanged: subscribe<null>('agents:changed'),

  // projects (app-managed library)
  projectsList: (): Promise<ProjectsState> => ipcRenderer.invoke('project:list'),
  getActiveProject: (): Promise<ProjectInfo | null> => ipcRenderer.invoke('project:getActive'),
  projectCreate: (name: string): Promise<ProjectInfo> => ipcRenderer.invoke('project:create', name),
  projectSwitch: (id: string): Promise<ProjectInfo | null> => ipcRenderer.invoke('project:switch', id),
  projectRename: (id: string, name: string): Promise<void> => ipcRenderer.invoke('project:rename', { id, name }),
  projectRemove: (id: string): Promise<ProjectsState> => ipcRenderer.invoke('project:remove', id),
  onProjectsChanged: subscribe<ProjectsState>('projects:changed'),

  // graph
  graphGet: (): Promise<GraphState | null> => ipcRenderer.invoke('graph:get'),
  graphSetPositions: (positions: { id: string; position: { x: number; y: number } }[]): Promise<void> =>
    ipcRenderer.invoke('graph:setPositions', positions),
  openGraphWindow: (): Promise<void> => ipcRenderer.invoke('graph:openWindow'),
  exportGraph: (): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('graph:export'),
  onGraphChanged: subscribe<GraphChangedPayload>('graph:changed'),

  // goals & tasks
  tasksGet: (): Promise<TasksState | null> => ipcRenderer.invoke('tasks:get'),
  tasksAddGoal: (p: { title: string; note?: string }): Promise<unknown> => ipcRenderer.invoke('tasks:addGoal', p),
  tasksUpdateGoal: (p: { goalId: string; title?: string; note?: string }): Promise<unknown> =>
    ipcRenderer.invoke('tasks:updateGoal', p),
  tasksAddTask: (p: { goalId: string; title: string }): Promise<unknown> => ipcRenderer.invoke('tasks:addTask', p),
  tasksUpdateTask: (p: { taskId: string; title?: string; status?: TaskStatus; note?: string }): Promise<unknown> =>
    ipcRenderer.invoke('tasks:updateTask', p),
  tasksRemove: (ids: string[]): Promise<unknown> => ipcRenderer.invoke('tasks:remove', ids),
  onTasksChanged: subscribe<TasksChangedPayload>('tasks:changed'),

  // prompt queue + usage-limit auto-resume
  // (promptInject enqueues; the queue drains immediately when usage is available)
  promptInject: (opts: { termId: string; text: string }): Promise<void> =>
    ipcRenderer.invoke('prompt:inject', opts),
  resumeGet: (): Promise<ResumeState[]> => ipcRenderer.invoke('resume:get'),
  resumeNow: (termId: string): Promise<void> => ipcRenderer.invoke('resume:now', termId),
  resumeCancel: (termId: string): Promise<void> => ipcRenderer.invoke('resume:cancel', termId),
  onResumeChanged: subscribe<ResumeState>('resume:changed'),

  // node source files
  openFile: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('file:open', path),
  revealFile: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('file:reveal', path),

  // diagnostics
  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke('app:diagnostics'),
  checkLogin: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('app:checkLogin'),

  // updates
  updatesCheck: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
  updatesApply: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('updates:apply'),
  onUpdatesAvailable: subscribe<UpdateStatus>('updates:available')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
