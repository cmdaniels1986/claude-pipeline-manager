import { useEffect, useRef, useState } from 'react'
import { AGENT_COLORS } from '../../../shared/types'
import { useGraphStore } from '../graph/graphStore'
import { useTaskStore } from '../stores/taskStore'
import { useTerminalStore, type PaneRec } from '../stores/terminalStore'
import { collectActivity, describeTerminal } from './terminalActivity'
import { TerminalPane } from './TerminalPane'
import { usageBadge } from './usageFormat'

const STATUS_DOT: Record<PaneRec['status'], string> = {
  starting: '#e3b341',
  live: '#3fb950',
  exited: '#f85149'
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgba([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** black or near-white text, whichever reads better on `hex` (WCAG luminance). */
function readableOn(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return 'var(--text)'
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.42 ? '#08110f' : '#eafbf7'
}

/** Active tab = filled with the color; inactive = a soft tint of it so the tab
 *  still reads as "that color" without drowning out the text. */
function tabStyle(color: string | undefined, active: boolean): React.CSSProperties | undefined {
  if (!color) return undefined
  const rgb = hexToRgb(color)
  if (!rgb) return undefined
  if (active) {
    return {
      background: color,
      color: readableOn(color),
      borderColor: color,
      boxShadow: `0 0 10px ${rgba(rgb, 0.4)}`
    }
  }
  return {
    background: rgba(rgb, 0.16),
    borderColor: rgba(rgb, 0.5),
    color: 'var(--text)'
  }
}

export function TerminalTabs({ onNewTerminal }: { onNewTerminal: () => void }): React.JSX.Element {
  const { panes, activePaneId, usage, billingReal, setActive, removePane, releasePane, renamePane, recolorPane } =
    useTerminalStore()
  // events the app recorded for each terminal (graph + goals/tasks), for the
  // "what did this terminal work on" tab tooltip
  const graphEvents = useGraphStore((s) => s.graph?.events)
  const mineEvents = useTaskStore((s) => s.mine?.events)
  const sharedEvents = useTaskStore((s) => s.shared?.events)
  const [menu, setMenu] = useState<{ x: number; y: number; paneId: string } | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (menu) renameRef.current?.select()
  }, [menu])

  const openMenu = (e: React.MouseEvent, pane: PaneRec): void => {
    e.preventDefault()
    setRenameText(pane.label)
    setMenu({ x: e.clientX, y: e.clientY, paneId: pane.paneId })
  }

  const popOut = (pane: PaneRec): void => {
    if (!pane.termId || pane.status !== 'live') return
    void window.api.termPopout({ termId: pane.termId })
    releasePane(pane.paneId)
  }

  const closeTab = (pane: PaneRec): void => {
    if (pane.termId) void window.api.termDispose(pane.termId)
    removePane(pane.paneId)
  }

  const commitRename = (pane: PaneRec): void => {
    const name = renameText.trim()
    if (name && name !== pane.label) {
      renamePane(pane.paneId, name)
      if (pane.termId) void window.api.termSetLabel(pane.termId, name)
    }
    setMenu(null)
  }

  const recolor = (pane: PaneRec, color: string | undefined): void => {
    recolorPane(pane.paneId, color)
    if (pane.termId) void window.api.termSetColor(pane.termId, color ?? null)
  }

  const menuPane = menu ? panes.find((p) => p.paneId === menu.paneId) : undefined

  if (!panes.length) {
    return (
      <div className="empty-state">
        <h2>No terminals yet</h2>
        <p>Open a project folder and launch your first Claude terminal.</p>
        <button className="primary" onClick={onNewTerminal}>
          ＋ New Terminal
        </button>
      </div>
    )
  }

  const taskEvents = [...(mineEvents ?? []), ...(sharedEvents ?? [])]

  return (
    <div className="terminal-tabs">
      <div className="tab-bar">
        {panes.map((pane) => {
          const active = pane.paneId === activePaneId
          const workedOn = describeTerminal(pane, collectActivity(pane.termId, graphEvents, taskEvents))
          return (
            <div
              key={pane.paneId}
              className={`tab${active ? ' active' : ''}${pane.color ? ' colored' : ''}`}
              style={tabStyle(pane.color, active)}
              title={pane.cwd}
              draggable
              onClick={() => setActive(pane.paneId)}
              onDoubleClick={(e) => openMenu(e, pane)}
              onContextMenu={(e) => openMenu(e, pane)}
              onDragEnd={(e) => {
                // dropped outside the app window → pop the terminal out
                if (e.screenX === 0 && e.screenY === 0) return // cancelled drag
                const outside =
                  e.screenX < window.screenX ||
                  e.screenX > window.screenX + window.outerWidth ||
                  e.screenY < window.screenY ||
                  e.screenY > window.screenY + window.outerHeight
                if (outside) popOut(pane)
              }}
            >
              {pane.busy && pane.status === 'live' ? (
                <span className="tab-spinner" title="Claude is working…" />
              ) : (
                <span className="tab-dot" style={{ background: STATUS_DOT[pane.status] }} />
              )}
              <span className="tab-label" title={workedOn}>
                {pane.label}
              </span>
              {pane.termId && usage[pane.termId] && (
                <span className="tab-tokens" title="Session cost so far (≈ = notional; subscription is flat-rate)">
                  {usageBadge(usage[pane.termId], billingReal)}
                </span>
              )}
              <button
                className="icon-button tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(pane)
                }}
                title="Close terminal"
              >
                ✕
              </button>
            </div>
          )
        })}
        <button className="tab-new" onClick={onNewTerminal} title="New terminal">
          ＋
        </button>
      </div>

      <div className="tab-stack">
        {panes.map((pane) => (
          <div
            key={pane.paneId}
            className="tab-stack-item"
            style={{ visibility: pane.paneId === activePaneId ? 'visible' : 'hidden' }}
          >
            <TerminalPane pane={pane} isActive={pane.paneId === activePaneId} showHeader={false} />
          </div>
        ))}
      </div>

      {menu && menuPane && (
        <>
          <div className="context-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={() => setMenu(null)} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            <div className="context-menu-title">Rename tab</div>
            <input
              ref={renameRef}
              className="tab-rename-input"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(menuPane)
                else if (e.key === 'Escape') setMenu(null)
              }}
              placeholder="Tab name"
              maxLength={60}
            />
            <div className="context-menu-title">Color</div>
            <div className="tab-color-row">
              {AGENT_COLORS.map((c) => (
                <button
                  key={c}
                  className={`tab-swatch${menuPane.color === c ? ' selected' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => recolor(menuPane, c)}
                />
              ))}
              <button
                className={`tab-swatch tab-swatch-clear${menuPane.color ? '' : ' selected'}`}
                title="No color"
                onClick={() => recolor(menuPane, undefined)}
              >
                ⦸
              </button>
            </div>
            <div className="context-menu-divider" />
            <button
              disabled={menuPane.status !== 'live'}
              onClick={() => {
                setMenu(null)
                popOut(menuPane)
              }}
            >
              🗔 Move to its own window
            </button>
            <button
              onClick={() => {
                setMenu(null)
                closeTab(menuPane)
              }}
            >
              ✕ Close terminal
            </button>
          </div>
        </>
      )}
    </div>
  )
}
