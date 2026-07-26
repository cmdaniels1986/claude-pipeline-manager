import { create } from 'zustand'

export interface PaneRec {
  paneId: string
  /** create = spawn a new session; attach = bind to an already-running termId */
  mode: 'create' | 'attach'
  cwd: string
  agentName?: string
  model?: string
  color?: string
  dangerous?: boolean
  termId?: string
  label: string
  status: 'starting' | 'live' | 'exited'
  exitCode?: number
}

interface TerminalStore {
  panes: PaneRec[]
  activePaneId: string | null
  addPane: (opts: {
    cwd: string
    agentName?: string
    model?: string
    color?: string
    dangerous?: boolean
  }) => void
  adoptPane: (opts: { termId: string; label: string; cwd: string; color?: string }) => void
  setActive: (paneId: string) => void
  setLive: (paneId: string, termId: string, label: string) => void
  setExited: (termId: string, exitCode: number) => void
  /** remove the tab and kill nothing — used when the terminal moves to another window */
  releasePane: (paneId: string) => void
  removePane: (paneId: string) => void
}

let paneCounter = 0

function withoutPane(s: TerminalStore, paneId: string): Pick<TerminalStore, 'panes' | 'activePaneId'> {
  const panes = s.panes.filter((p) => p.paneId !== paneId)
  const activePaneId =
    s.activePaneId === paneId ? (panes[panes.length - 1]?.paneId ?? null) : s.activePaneId
  return { panes, activePaneId }
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  panes: [],
  activePaneId: null,
  addPane: (opts) =>
    set((s) => {
      const paneId = `pane-${++paneCounter}`
      return {
        panes: [
          ...s.panes,
          {
            paneId,
            mode: 'create' as const,
            cwd: opts.cwd,
            agentName: opts.agentName,
            model: opts.model,
            color: opts.color,
            dangerous: opts.dangerous,
            label: opts.agentName ?? 'claude',
            status: 'starting' as const
          }
        ],
        activePaneId: paneId
      }
    }),
  adoptPane: (opts) =>
    set((s) => {
      const existing = s.panes.find((p) => p.termId === opts.termId)
      if (existing) return { activePaneId: existing.paneId }
      const paneId = `pane-${++paneCounter}`
      return {
        panes: [
          ...s.panes,
          {
            paneId,
            mode: 'attach' as const,
            cwd: opts.cwd,
            termId: opts.termId,
            label: opts.label,
            color: opts.color,
            status: 'live' as const
          }
        ],
        activePaneId: paneId
      }
    }),
  setActive: (paneId) => set({ activePaneId: paneId }),
  setLive: (paneId, termId, label) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.paneId === paneId ? { ...p, termId, label, status: 'live' as const } : p))
    })),
  setExited: (termId, exitCode) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.termId === termId ? { ...p, status: 'exited' as const, exitCode } : p))
    })),
  releasePane: (paneId) => set((s) => withoutPane(s, paneId)),
  removePane: (paneId) => set((s) => withoutPane(s, paneId))
}))

// ---- terminal data routing -------------------------------------------------
// One global subscription per window; the main process sends each terminal's
// output only to the window hosting it. Output arriving before the pane's
// xterm attaches is buffered per termId and flushed on attach.

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
  window.api.onTermExit(({ termId, exitCode }) => {
    useTerminalStore.getState().setExited(termId, exitCode)
  })
  window.api.onTermAdopt((opts) => {
    useTerminalStore.getState().adoptPane(opts)
  })
  ;(window as unknown as Record<string, unknown>).__termDebug = {
    tail: (termId: string, chars = 4000): string => (debugTails.get(termId) ?? '').slice(-chars)
  }
  ;(window as unknown as Record<string, unknown>).__termStore = useTerminalStore
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
