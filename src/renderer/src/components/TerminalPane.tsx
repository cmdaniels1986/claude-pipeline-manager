import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { useEffect, useRef } from 'react'
import { attachTermData, useTerminalStore, type PaneRec } from '../stores/terminalStore'

const TERM_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78'
}

export function TerminalPane({ pane }: { pane: PaneRec }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)
  const setLive = useTerminalStore((s) => s.setLive)
  const removePane = useTerminalStore((s) => s.removePane)

  useEffect(() => {
    if (!hostRef.current || startedRef.current) return
    startedRef.current = true
    const host = hostRef.current

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 8000,
      theme: TERM_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable — canvas renderer fallback is automatic
    }
    fit.fit()

    let detach: (() => void) | null = null
    let termId: string | null = null
    let disposed = false

    // Spawn only after the first fit so the CLI boots at the real pane size
    window.api
      .termCreate({
        cwd: pane.cwd,
        agentName: pane.agentName,
        model: pane.model,
        cols: term.cols,
        rows: term.rows
      })
      .then((info) => {
        if (disposed) {
          void window.api.termDispose(info.termId)
          return
        }
        termId = info.termId
        setLive(pane.paneId, info.termId, info.label)
        detach = attachTermData(info.termId, (data) => term.write(data))
        term.onData((data) => window.api.termInput(info.termId, data))
        term.focus()
      })
      .catch((err) => {
        term.writeln(`\r\nFailed to start Claude: ${String(err)}`)
      })

    let resizeTimer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        fit.fit()
        if (termId) window.api.termResize(termId, term.cols, term.rows)
      }, 100)
    })
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      window.clearTimeout(resizeTimer)
      detach?.()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = (): void => {
    if (pane.termId) void window.api.termDispose(pane.termId)
    removePane(pane.paneId)
  }

  return (
    <div className="terminal-pane">
      <div className="terminal-pane-header">
        <span className="terminal-pane-title" title={pane.cwd}>
          {pane.label}
          <span className="terminal-pane-cwd"> — {pane.cwd}</span>
        </span>
        <button className="icon-button" onClick={close} title="Close terminal">
          ✕
        </button>
      </div>
      <div className="terminal-pane-body" ref={hostRef} />
      {pane.status === 'exited' && (
        <div className="terminal-pane-overlay">
          <div>
            <p>Session ended (exit code {pane.exitCode ?? '?'})</p>
            <button onClick={close}>Close pane</button>
          </div>
        </div>
      )}
    </div>
  )
}
