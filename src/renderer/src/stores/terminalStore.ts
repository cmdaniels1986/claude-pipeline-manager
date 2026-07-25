import { create } from 'zustand'

export interface PaneRec {
  paneId: string
  cwd: string
  agentName?: string
  model?: string
  termId?: string
  label: string
  status: 'starting' | 'live' | 'exited'
  exitCode?: number
}

interface TerminalStore {
  panes: PaneRec[]
  addPane: (opts: { cwd: string; agentName?: string; model?: string }) => void
  setLive: (paneId: string, termId: string, label: string) => void
  setExited: (termId: string, exitCode: number) => void
  removePane: (paneId: string) => void
}

let paneCounter = 0

export const useTerminalStore = create<TerminalStore>((set) => ({
  panes: [],
  addPane: (opts) =>
    set((s) => ({
      panes: [
        ...s.panes,
        {
          paneId: `pane-${++paneCounter}`,
          cwd: opts.cwd,
          agentName: opts.agentName,
          model: opts.model,
          label: opts.agentName ?? 'claude',
          status: 'starting'
        }
      ]
    })),
  setLive: (paneId, termId, label) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.paneId === paneId ? { ...p, termId, label, status: 'live' as const } : p))
    })),
  setExited: (termId, exitCode) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.termId === termId ? { ...p, status: 'exited' as const, exitCode } : p))
    })),
  removePane: (paneId) => set((s) => ({ panes: s.panes.filter((p) => p.paneId !== paneId) }))
}))

// ---- terminal data routing -------------------------------------------------
// One global subscription; output arriving before a pane attaches (the gap between
// PTY spawn and xterm mount) is buffered per termId and flushed on attach.

const handlers = new Map<string, (data: string) => void>()
const buffers = new Map<string, string[]>()
const debugTails = new Map<string, string>()

if (typeof window !== 'undefined' && window.api) {
  window.api.onTermData(({ termId, data }) => {
    debugTails.set(termId, ((debugTails.get(termId) ?? '') + data).slice(-30000))
    const handler = handlers.get(termId)
    if (handler) {
      handler(data)
    } else {
      const buf = buffers.get(termId) ?? []
      buf.push(data)
      buffers.set(termId, buf)
    }
  })
  ;(window as unknown as Record<string, unknown>).__termDebug = {
    tail: (termId: string, chars = 4000): string => (debugTails.get(termId) ?? '').slice(-chars)
  }
  window.api.onTermExit(({ termId, exitCode }) => {
    useTerminalStore.getState().setExited(termId, exitCode)
  })
}

export function attachTermData(termId: string, cb: (data: string) => void): () => void {
  const buffered = buffers.get(termId)
  if (buffered) {
    for (const chunk of buffered) cb(chunk)
    buffers.delete(termId)
  }
  handlers.set(termId, cb)
  return () => {
    handlers.delete(termId)
  }
}
