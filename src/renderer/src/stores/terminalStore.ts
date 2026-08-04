import { create } from 'zustand'
import type { ResumeState, TermUsage } from '../../../shared/types'

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
  /** true once the user has hand-named this tab, so setLive won't overwrite it */
  renamed?: boolean
  status: 'starting' | 'live' | 'exited'
  /** Claude is actively working in this terminal (drives the spinning tab icon) */
  busy?: boolean
  exitCode?: number
}

interface TerminalStore {
  panes: PaneRec[]
  activePaneId: string | null
  usage: Record<string, TermUsage>
  setUsage: (usage: TermUsage) => void
  resume: Record<string, ResumeState>
  setResume: (state: ResumeState) => void
  /** true when sessions bill per-token (API key) — cost is real, not notional */
  billingReal: boolean
  addPane: (opts: {
    cwd: string
    agentName?: string
    model?: string
    color?: string
    dangerous?: boolean
  }) => void
  adoptPane: (opts: { termId: string; label: string; cwd: string; color?: string }) => void
  setActive: (paneId: string) => void
  /** flip a terminal's "Claude is working" state (drives the spinning tab icon) */
  setBusy: (termId: string, busy: boolean) => void
  /** give a tab a custom name (right-click → rename) */
  renamePane: (paneId: string, label: string) => void
  /** change a tab's accent color (undefined clears it) */
  recolorPane: (paneId: string, color: string | undefined) => void
  setLive: (paneId: string, termId: string, label: string) => void
  setExited: (termId: string, exitCode: number) => void
  /** a session was relaunched (--resume) after a usage limit — flip it back to live */
  setResumedLive: (termId: string) => void
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
  usage: {},
  setUsage: (usage) => set((s) => ({ usage: { ...s.usage, [usage.termId]: usage } })),
  resume: {},
  setResume: (state) => set((s) => ({ resume: { ...s.resume, [state.termId]: state } })),
  billingReal: false,
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
  setBusy: (termId, busy) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.termId === termId ? { ...p, busy } : p))
    })),
  renamePane: (paneId, label) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.paneId === paneId ? { ...p, label, renamed: true } : p))
    })),
  recolorPane: (paneId, color) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.paneId === paneId ? { ...p, color } : p))
    })),
  setLive: (paneId, termId, label) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        // don't clobber a name the user set before the session went live
        p.paneId === paneId ? { ...p, termId, label: p.renamed ? p.label : label, status: 'live' as const } : p
      )
    })),
  setExited: (termId, exitCode) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.termId === termId ? { ...p, status: 'exited' as const, exitCode, busy: false } : p
      )
    })),
  setResumedLive: (termId) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.termId === termId ? { ...p, status: 'live' as const, exitCode: undefined } : p
      )
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

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
// OSC: ESC ] ... (BEL or ESC \ terminator)
const OSC = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g')
// CSI: ESC [ , param bytes 0-9:;<=>? , intermediate bytes space-/ , final byte @-~
const CSI = new RegExp(ESC + '\\[[0-9:;<=>?]*[ -/]*[@-~]', 'g')
// other ESC sequences (charset selection, single-char, etc.)
const ESC_OTHER = new RegExp(ESC + '[ -/]*[0-~]', 'g')
// leftover control chars except tab and newline
const CTRL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** Raw terminal output with ANSI/control noise stripped, for showing crash reasons. */
export function getTermTailText(termId: string, chars = 2500): string {
  const raw = debugTails.get(termId) ?? ''
  const clean = raw
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC_OTHER, '')
    .replace(CTRL, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return clean.trim().slice(-chars)
}

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
  window.api.onTermUsage((usage) => {
    useTerminalStore.getState().setUsage(usage)
  })
  window.api.onTermActivity(({ termId, busy }) => {
    useTerminalStore.getState().setBusy(termId, busy)
  })
  window.api.onResumeChanged((state) => useTerminalStore.getState().setResume(state))
  window.api.onTermResumed((termId) => useTerminalStore.getState().setResumedLive(termId))
  void window.api.resumeGet().then((states) => {
    const store = useTerminalStore.getState()
    for (const s of states) store.setResume(s)
  })
  void window.api.getDiagnostics().then((d) => useTerminalStore.setState({ billingReal: d.apiKeyBilling }))
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
