import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PreviewCandidate, PreviewReload, TermInfo } from '../../../shared/types'
import { usePreviewStore } from '../stores/previewStore'
import { useTerminalStore } from '../stores/terminalStore'
import type { PreviewWebviewElement } from '../webview'

/**
 * Live web preview: an embedded browser (<webview>) pointed at whatever local dev
 * server the terminals are running — Vite, Flask, Django, Next, static files, any
 * stack, since all of them end up as a URL on localhost. What to show and when to
 * reload comes from the main process (PreviewManager); this pane renders it and
 * closes the loop back to Claude with screenshots and console errors.
 */

type Preset = 'fit' | 390 | 768 | 1280
const PRESETS: { key: Preset; label: string; title: string }[] = [
  { key: 'fit', label: 'Fit', title: 'Fill the panel' },
  { key: 390, label: '📱 390', title: 'Phone width (390px)' },
  { key: 768, label: '▭ 768', title: 'Tablet width (768px)' },
  { key: 1280, label: '🖥 1280', title: 'Desktop width (1280px)' }
]

interface ConsoleEntry {
  id: number
  level: 'warning' | 'error'
  message: string
  source?: string
  line?: number
}

const MAX_CONSOLE = 50
const RETRY_MS = 2500
const AUTO_KEY = 'preview.autoReload'

/** Probe the loaded page for a hot-reload client; when one is present the pane
 *  leaves reloading to it (a forced reload would throw away HMR state). */
const HMR_PROBE = `(() => { try {
  if (document.querySelector('script[src*="/@vite/client"]') || window.__vite_plugin_react_preamble_installed__) return 'Vite HMR'
  if (window.__NEXT_DATA__ || document.querySelector('script[src*="/_next/"]')) return 'Next.js HMR'
  if (Object.keys(window).some((k) => k.startsWith('webpackHotUpdate')) || window.__webpack_hash__) return 'webpack HMR'
  if (window.___browserSync___ || window.LiveReload || window.livereload) return 'live reload'
  if (window.__parcel__ || Object.keys(window).some((k) => k.startsWith('parcelRequire'))) return 'Parcel HMR'
  return null
} catch { return null } })()`

function short(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' && !u.search ? '' : u.pathname + u.search
    return `${u.host}${path}`
  } catch {
    return url
  }
}

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off'
  } catch {
    return true
  }
}

export function PreviewDock({ onClose, popped }: { onClose?: () => void; popped?: boolean }): React.JSX.Element {
  const state = usePreviewStore((s) => s.state)
  const panes = useTerminalStore((s) => s.panes)
  const activePaneId = useTerminalStore((s) => s.activePaneId)
  const url = state?.url ?? null

  const wvRef = useRef<PreviewWebviewElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [input, setInput] = useState(url ?? '')
  const [editing, setEditing] = useState(false)
  const [current, setCurrent] = useState<string | null>(url)
  const [title, setTitle] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<{ code: number; desc: string } | null>(null)
  const [hmr, setHmr] = useState<string | null>(null)
  const [autoReload, setAutoReload] = useState(readAuto)
  const [preset, setPreset] = useState<Preset>('fit')
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [consoleLog, setConsoleLog] = useState<ConsoleEntry[]>([])
  const [showConsole, setShowConsole] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [targetTermId, setTargetTermId] = useState<string | null>(null)
  const [dismissedCandidate, setDismissedCandidate] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [lastReload, setLastReload] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const consoleId = useRef(0)
  const autoRef = useRef(autoReload)
  const hmrRef = useRef(hmr)
  autoRef.current = autoReload
  hmrRef.current = hmr

  // keep the URL bar in step with the pane unless the user is typing in it
  useEffect(() => {
    if (!editing) setInput(current ?? url ?? '')
  }, [current, url, editing])
  useEffect(() => {
    setCurrent(url)
    setFailed(null)
    setHmr(null)
    setTitle(null)
    setConsoleLog([])
  }, [url])

  // live terminals to send screenshots / console errors to
  const refreshTerms = useCallback(async (): Promise<void> => {
    const list = (await window.api.termList()).filter((t) => t.alive)
    setTerms(list)
  }, [])
  useEffect(() => {
    void refreshTerms()
    const offExit = window.api.onTermExit(() => void refreshTerms())
    const offAdopt = window.api.onTermAdopt(() => void refreshTerms())
    const offResumed = window.api.onTermResumed(() => void refreshTerms())
    return () => {
      offExit()
      offAdopt()
      offResumed()
    }
  }, [refreshTerms])
  useEffect(() => {
    // new terminal tabs appear in the store first; pick them up too
    void refreshTerms()
  }, [panes.length, refreshTerms])
  const activeTermId = panes.find((p) => p.paneId === activePaneId)?.termId ?? null
  const resolvedTarget = useMemo(() => {
    if (targetTermId && terms.some((t) => t.termId === targetTermId)) return targetTermId
    if (activeTermId && terms.some((t) => t.termId === activeTermId)) return activeTermId
    return terms[0]?.termId ?? null
  }, [targetTermId, activeTermId, terms])
  const targetLabel = terms.find((t) => t.termId === resolvedTarget)?.label ?? null

  // size the stage so viewport presets can scale down to fit the panel
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setStage({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [url])

  // ---- webview events -------------------------------------------------------
  useEffect(() => {
    const wv = wvRef.current
    if (!wv || !url) return
    const onStart = (): void => {
      setLoading(true)
    }
    const onStop = (): void => {
      setLoading(false)
      try {
        setCanBack(wv.canGoBack())
        setCanFwd(wv.canGoForward())
      } catch {
        // webview not attached yet
      }
    }
    const onFail = (e: Event): void => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean }
      if (!ev.isMainFrame || ev.errorCode === -3) return // -3 = ERR_ABORTED (navigation superseded)
      setFailed({ code: ev.errorCode, desc: ev.errorDescription })
      setHmr(null)
    }
    const onNavigate = (e: Event): void => {
      const ev = e as unknown as { url: string }
      if (ev.url) setCurrent(ev.url)
      setFailed(null)
      // a fresh document (navigation or reload): its console starts empty
      setConsoleLog([])
    }
    const onNavigateInPage = (e: Event): void => {
      const ev = e as unknown as { url: string }
      if (ev.url) setCurrent(ev.url)
    }
    const onReady = (): void => {
      setFailed(null)
      void wv
        .executeJavaScript(HMR_PROBE)
        .then((r) => setHmr(typeof r === 'string' ? r : null))
        .catch(() => setHmr(null))
    }
    const onTitle = (e: Event): void => {
      const ev = e as unknown as { title: string }
      setTitle(ev.title || null)
    }
    const onConsole = (e: Event): void => {
      const ev = e as unknown as { level: number | string; message: string; sourceId?: string; line?: number }
      // webview tag reports level as 0-3 (verbose/info/warning/error); tolerate the
      // string form newer webContents events use
      const level: ConsoleEntry['level'] | null =
        typeof ev.level === 'number'
          ? ev.level >= 3
            ? 'error'
            : ev.level === 2
              ? 'warning'
              : null
          : ev.level === 'error'
            ? 'error'
            : ev.level === 'warning'
              ? 'warning'
              : null
      if (!level) return
      // Electron's own unpackaged-app CSP nag is about this app, not the user's page
      if (/Electron Security Warning/.test(ev.message)) return
      setConsoleLog((log) =>
        [...log, { id: ++consoleId.current, level, message: ev.message, source: ev.sourceId, line: ev.line }].slice(-MAX_CONSOLE)
      )
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigateInPage)
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('console-message', onConsole)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigateInPage)
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('console-message', onConsole)
    }
  }, [url])

  // while the server is unreachable (restarting, not started yet) keep retrying
  useEffect(() => {
    if (!failed || !url) return
    const t = setInterval(() => {
      try {
        wvRef.current?.reload()
      } catch {
        // not attached
      }
    }, RETRY_MS)
    return () => clearInterval(t)
  }, [failed, url])

  // reload requests from the main process: agents (always) and the project file
  // watcher (only when auto-reload is on and the page has no hot-reload client)
  useEffect(() => {
    return window.api.onPreviewReload((r: PreviewReload) => {
      if (r.reason === 'files' && (!autoRef.current || hmrRef.current)) return
      try {
        wvRef.current?.reload()
      } catch {
        return
      }
      const what = r.reason === 'agent' ? 'agent asked' : r.path ? r.path.replace(/^.*[\\/]/, '') + ' changed' : 'files changed'
      setLastReload(`${what} · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`)
    })
  }, [])

  const flash = (msg: string): void => {
    setNote(msg)
    setTimeout(() => setNote((n) => (n === msg ? null : n)), 6000)
  }

  const go = async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (!text) return
    const r = await window.api.previewSet(text)
    if (!r.ok) flash('⚠ ' + r.error)
    else if (r.url === url) wvRef.current?.reload()
    setEditing(false)
  }

  const toggleAuto = (): void => {
    const next = !autoReload
    setAutoReload(next)
    try {
      localStorage.setItem(AUTO_KEY, next ? 'on' : 'off')
    } catch {
      // storage unavailable — session-only
    }
  }

  const screenshot = async (): Promise<void> => {
    const wv = wvRef.current
    if (!wv || !resolvedTarget) return
    setBusy(true)
    try {
      const r = await window.api.previewScreenshot({ webContentsId: wv.getWebContentsId(), termId: resolvedTarget })
      if (!r.ok) {
        flash('⚠ ' + r.error)
        return
      }
      // bring the receiving tab forward so the user can add what to change and press Enter
      const pane = panes.find((p) => p.termId === resolvedTarget)
      if (pane) useTerminalStore.getState().setActive(pane.paneId)
      flash(`📸 Screenshot pasted into “${targetLabel ?? 'terminal'}” — describe what to change, then press Enter`)
    } finally {
      setBusy(false)
    }
  }

  const sendConsole = async (): Promise<void> => {
    if (!resolvedTarget || !consoleLog.length) return
    const lines = consoleLog.map((c) => `- [${c.level}] ${c.message}${c.source ? ` (${c.source.replace(/^.*[\\/]/, '')}${c.line ? `:${c.line}` : ''})` : ''}`)
    const text = `The live preview at ${current ?? url} logged these browser console ${consoleLog.some((c) => c.level === 'error') ? 'errors' : 'warnings'}:\n${lines.join('\n')}\nPlease find and fix the underlying cause.`
    await window.api.promptInject({ termId: resolvedTarget, text })
    flash(`Sent ${consoleLog.length} console message${consoleLog.length > 1 ? 's' : ''} to “${targetLabel ?? 'terminal'}”`)
    setConsoleLog([])
    setShowConsole(false)
  }

  const popOut = (): void => {
    void window.api.openPreviewWindow()
    onClose?.()
  }

  // a server that appeared after the current page was picked → offer it
  const newest: PreviewCandidate | null = state?.candidates[0] ?? null
  const offer =
    newest && url && newest.url !== url && newest.url !== dismissedCandidate && (!state?.selectedAt || newest.ts > state.selectedAt)
      ? newest
      : null

  const errors = consoleLog.filter((c) => c.level === 'error').length
  const warnings = consoleLog.length - errors

  // viewport preset geometry (scale down when the preset is wider than the stage)
  const presetPx = preset === 'fit' ? null : preset
  const scale = presetPx ? Math.min(1, Math.max(0.1, (stage.w - 2) / presetPx)) : 1
  const frameStyle: React.CSSProperties = presetPx
    ? {
        width: presetPx,
        height: Math.max(0, stage.h / scale),
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        left: Math.max(0, (stage.w - presetPx * scale) / 2),
        position: 'absolute',
        top: 0
      }
    : { position: 'absolute', inset: 0 }

  return (
    <div className={`graph-dock preview-dock${popped ? ' popped' : ''}`}>
      <div className="graph-dock-header">
        <span className="graph-dock-title">🖥 Live Preview</span>
        {state?.label && <span className="preview-label">{state.label}</span>}
        {title && !state?.label && (
          <span className="activity" title={title}>
            {title}
          </span>
        )}
        <span className="spacer" />
        {terms.length > 1 && (
          <select
            className="preview-target"
            value={resolvedTarget ?? ''}
            onChange={(e) => setTargetTermId(e.target.value || null)}
            onFocus={() => void refreshTerms()}
            title="Which Claude session receives screenshots and console errors"
          >
            {terms.map((t) => (
              <option key={t.termId} value={t.termId}>
                → {t.label}
              </option>
            ))}
          </select>
        )}
        <button
          className="icon-button"
          onClick={() => void screenshot()}
          disabled={!url || !resolvedTarget || busy || !!failed}
          title={
            resolvedTarget
              ? `Paste a screenshot of this page into “${targetLabel}” so Claude can see what it built`
              : 'Start a terminal first — screenshots are pasted into a Claude session'
          }
        >
          📸
        </button>
        {!popped && (
          <button className="icon-button" onClick={popOut} title="Pop out into its own window">
            ⧉
          </button>
        )}
        {onClose && (
          <button className="icon-button" onClick={onClose} title="Close preview panel">
            ✕
          </button>
        )}
      </div>

      <div className="preview-toolbar">
        <button className="icon-button" onClick={() => wvRef.current?.goBack()} disabled={!canBack} title="Back">
          ◀
        </button>
        <button className="icon-button" onClick={() => wvRef.current?.goForward()} disabled={!canFwd} title="Forward">
          ▶
        </button>
        <button
          className="icon-button"
          onClick={() => wvRef.current?.reload()}
          disabled={!url}
          title="Reload the page"
        >
          ⟳
        </button>
        <form
          className="preview-urlbar"
          onSubmit={(e) => {
            e.preventDefault()
            void go(input)
          }}
        >
          <input
            value={input}
            placeholder="localhost:5173  ·  5000  ·  http://127.0.0.1:8000/admin"
            spellCheck={false}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setInput(current ?? url ?? '')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          {loading && <span className="preview-spinner" title="Loading…" />}
        </form>
        {!!state?.candidates.length && (
          <select
            className="preview-candidates"
            value=""
            onChange={(e) => {
              if (e.target.value) void go(e.target.value)
            }}
            title="Dev servers seen in your terminals"
          >
            <option value="">servers ▾</option>
            {state.candidates.map((c) => (
              <option key={c.url} value={c.url}>
                {short(c.url)}
                {c.label ? ` — ${c.label}` : ''}
              </option>
            ))}
          </select>
        )}
        <select
          className="preview-preset"
          value={String(preset)}
          onChange={(e) => setPreset(e.target.value === 'fit' ? 'fit' : (Number(e.target.value) as Preset))}
          title="Viewport width"
        >
          {PRESETS.map((p) => (
            <option key={String(p.key)} value={String(p.key)} title={p.title}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          className={`preview-auto${autoReload ? ' on' : ''}`}
          onClick={toggleAuto}
          title={
            hmr
              ? `The page has ${hmr} — it updates itself, so file-change reloads are skipped`
              : 'Reload the page automatically when files in the project change (for servers without hot reload)'
          }
        >
          {hmr ? `⚡ ${hmr}` : autoReload ? '⟳ auto' : '⟳ manual'}
        </button>
      </div>

      {(offer || note || lastReload || consoleLog.length > 0) && (
        <div className="preview-status">
          {offer && (
            <span className="preview-offer">
              🆕 new server <b>{short(offer.url)}</b>
              <button onClick={() => void go(offer.url)}>Open</button>
              <button className="icon-button" onClick={() => setDismissedCandidate(offer.url)} title="Ignore">
                ✕
              </button>
            </span>
          )}
          {note && <span className="preview-note">{note}</span>}
          {!note && lastReload && <span className="preview-reloaded">reloaded · {lastReload}</span>}
          <span className="spacer" />
          {consoleLog.length > 0 && (
            <button
              className={`preview-console-badge${errors ? ' err' : ''}`}
              onClick={() => setShowConsole((v) => !v)}
              title="Browser console errors and warnings from the page"
            >
              {errors ? `⛔ ${errors}` : ''}
              {errors && warnings ? ' · ' : ''}
              {warnings ? `⚠ ${warnings}` : ''}
            </button>
          )}
        </div>
      )}

      {showConsole && consoleLog.length > 0 && (
        <div className="preview-console">
          <div className="preview-console-head">
            <span>Browser console</span>
            <span className="spacer" />
            <button className="primary" onClick={() => void sendConsole()} disabled={!resolvedTarget}>
              Send to Claude{targetLabel ? ` (${targetLabel})` : ''}
            </button>
            <button className="icon-button" onClick={() => setConsoleLog([])} title="Clear">
              🗑
            </button>
            <button className="icon-button" onClick={() => setShowConsole(false)} title="Hide">
              ✕
            </button>
          </div>
          <ul>
            {consoleLog.map((c) => (
              <li key={c.id} className={c.level}>
                <span className="lvl">{c.level === 'error' ? '⛔' : '⚠'}</span>
                <span className="msg">{c.message}</span>
                {c.source && (
                  <span className="src">
                    {c.source.replace(/^.*[\\/]/, '')}
                    {c.line ? `:${c.line}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="graph-dock-body preview-stage" ref={stageRef}>
        {url ? (
          <>
            <div className={`preview-frame${presetPx ? ' framed' : ''}`} style={frameStyle}>
              <webview ref={wvRef} src={url} partition="persist:preview" className="preview-webview" />
            </div>
            {failed && (
              <div className="preview-overlay">
                <div>
                  <p className="preview-overlay-title">Can’t reach {short(url)}</p>
                  <p className="preview-overlay-detail">
                    {failed.desc} · retrying every {RETRY_MS / 1000}s — start (or restart) the dev server in a terminal
                  </p>
                  <div className="row">
                    <button onClick={() => wvRef.current?.reload()}>Retry now</button>
                    <button onClick={() => void window.api.previewClear()}>Forget this URL</button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="preview-empty">
            <p className="preview-empty-title">Nothing to preview yet</p>
            <p>
              Start a dev server in any terminal — <code>npm run dev</code>, <code>flask run</code>,{' '}
              <code>python manage.py runserver</code>, <code>python -m http.server</code> — and its page appears here
              as soon as the URL shows up. Or type a port / URL above.
            </p>
            {!!state?.candidates.length && (
              <div className="preview-empty-cands">
                {state.candidates.map((c) => (
                  <button key={c.url} onClick={() => void go(c.url)}>
                    {short(c.url)}
                    {c.label ? ` — ${c.label}` : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
