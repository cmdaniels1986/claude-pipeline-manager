import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { useEffect, useRef, useState } from 'react'
import { attachTermData, getTermTailText, useTerminalStore, type PaneRec } from '../stores/terminalStore'
import { fmtCost, fmtTokens } from './usageFormat'

const TERM_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78'
}

export function TerminalPane({
  pane,
  isActive = true,
  showHeader = true
}: {
  pane: PaneRec
  isActive?: boolean
  showHeader?: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)
  const termRef = useRef<Terminal | null>(null)
  const setLive = useTerminalStore((s) => s.setLive)
  const removePane = useTerminalStore((s) => s.removePane)
  const addPane = useTerminalStore((s) => s.addPane)
  const usage = useTerminalStore((s) => (pane.termId ? s.usage[pane.termId] : undefined))
  const billingReal = useTerminalStore((s) => s.billingReal)
  const [showLog, setShowLog] = useState(false)

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
    termRef.current = term
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

    const wire = (id: string): void => {
      termId = id
      detach = attachTermData(id, (data) => term.write(data))
      term.onData((data) => window.api.termInput(id, data))
      term.focus()
    }

    if (pane.mode === 'attach' && pane.termId) {
      wire(pane.termId)
      // the session was rendering elsewhere: a resize at our (different) pane
      // size makes the TUI repaint its full screen here
      window.api.termResize(pane.termId, term.cols, term.rows)
    } else {
      // spawn only after the first fit so the CLI boots at the real pane size
      window.api
        .termCreate({
          cwd: pane.cwd,
          agentName: pane.agentName,
          model: pane.model,
          color: pane.color,
          dangerous: pane.dangerous,
          cols: term.cols,
          rows: term.rows
        })
        .then((info) => {
          if (disposed) {
            void window.api.termDispose(info.termId)
            return
          }
          setLive(pane.paneId, info.termId, info.label)
          wire(info.termId)
        })
        .catch((err) => {
          term.writeln(`\r\nFailed to start Claude: ${String(err)}`)
        })
    }

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
      termRef.current = null
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (isActive) termRef.current?.focus()
  }, [isActive])

  const close = (): void => {
    if (pane.termId) void window.api.termDispose(pane.termId)
    removePane(pane.paneId)
  }

  const restart = (): void => {
    addPane({
      cwd: pane.cwd,
      agentName: pane.agentName,
      model: pane.model,
      color: pane.color,
      dangerous: pane.dangerous
    })
    removePane(pane.paneId)
  }

  // a session that dies within a few seconds of launch almost certainly failed to
  // start (not logged in, bad flag, wrong CLI version) rather than exiting normally
  const exitedEarly = pane.status === 'exited' && pane.exitCode !== 0
  const crashLog = exitedEarly && pane.termId ? getTermTailText(pane.termId) : ''

  return (
    <div className="terminal-pane">
      {showHeader && (
        <div
          className="terminal-pane-header"
          style={pane.color ? { boxShadow: `inset 0 2px 0 ${pane.color}` } : undefined}
        >
          <span className="terminal-pane-title" title={pane.cwd}>
            {pane.color && <span className="agent-color-dot" style={{ background: pane.color }} />}
            {pane.label}
            <span className="terminal-pane-cwd"> — {pane.cwd}</span>
          </span>
          <button className="icon-button" onClick={close} title="Close terminal">
            ✕
          </button>
        </div>
      )}
      <div className="terminal-pane-body" ref={hostRef} />
      {usage && pane.status !== 'exited' && (
        <div className="usage-strip" title={usage.model ? `model: ${usage.model}` : undefined}>
          <span>↑ {fmtTokens(usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens)} in</span>
          <span>↓ {fmtTokens(usage.outputTokens)} out</span>
          {usage.cacheReadTokens > 0 && (
            <span className="usage-cache">{fmtTokens(usage.cacheReadTokens)} cached</span>
          )}
          {fmtCost(usage.costUsd) && (
            <span
              className="usage-cost"
              title={
                billingReal
                  ? 'Actual per-token API cost'
                  : 'Notional — your subscription is flat-rate, not billed per token'
              }
            >
              {billingReal ? '' : '≈ '}
              {fmtCost(usage.costUsd)}
            </span>
          )}
        </div>
      )}
      {pane.status === 'exited' && (
        <div className="terminal-pane-exitbar">
          <div className="exitbar-row">
            <span className={exitedEarly ? 'exit-bad' : 'exit-ok'}>
              {exitedEarly
                ? `⚠ Session failed to start (exit code ${pane.exitCode})`
                : `Session ended (exit code ${pane.exitCode ?? 0})`}
            </span>
            {exitedEarly && crashLog && (
              <button className="link-button" onClick={() => setShowLog((v) => !v)}>
                {showLog ? 'Hide output' : 'Show output'}
              </button>
            )}
            <span className="spacer" />
            <button onClick={restart}>↻ Restart</button>
            <button onClick={close}>Close</button>
          </div>
          {exitedEarly && (
            <div className="exitbar-hint">
              Common causes: Claude isn’t logged in on this machine (run <code>claude</code> in a
              terminal and log in), or a different CLI version. Use “Check login” in the toolbar to test.
            </div>
          )}
          {showLog && crashLog && <pre className="exitbar-log">{crashLog}</pre>}
        </div>
      )}
    </div>
  )
}
