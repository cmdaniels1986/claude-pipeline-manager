import { useState } from 'react'
import { useTerminalStore, type PaneRec } from '../stores/terminalStore'
import { TerminalPane } from './TerminalPane'
import { fmtTokens, totalTokens } from './usageFormat'

const STATUS_DOT: Record<PaneRec['status'], string> = {
  starting: '#e3b341',
  live: '#3fb950',
  exited: '#f85149'
}

export function TerminalTabs({ onNewTerminal }: { onNewTerminal: () => void }): React.JSX.Element {
  const { panes, activePaneId, usage, setActive, removePane, releasePane } = useTerminalStore()
  const [menu, setMenu] = useState<{ x: number; y: number; paneId: string } | null>(null)

  const popOut = (pane: PaneRec): void => {
    if (!pane.termId || pane.status !== 'live') return
    void window.api.termPopout({ termId: pane.termId })
    releasePane(pane.paneId)
  }

  const closeTab = (pane: PaneRec): void => {
    if (pane.termId) void window.api.termDispose(pane.termId)
    removePane(pane.paneId)
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

  return (
    <div className="terminal-tabs">
      <div className="tab-bar">
        {panes.map((pane) => (
          <div
            key={pane.paneId}
            className={`tab${pane.paneId === activePaneId ? ' active' : ''}`}
            style={pane.color ? { boxShadow: `inset 0 2px 0 ${pane.color}` } : undefined}
            title={pane.cwd}
            draggable
            onClick={() => setActive(pane.paneId)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, paneId: pane.paneId })
            }}
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
            <span className="tab-dot" style={{ background: STATUS_DOT[pane.status] }} />
            <span className="tab-label">{pane.label}</span>
            {pane.termId && usage[pane.termId] && (
              <span className="tab-tokens" title="Tokens used this session">
                {fmtTokens(totalTokens(usage[pane.termId]))}
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
        ))}
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
            <div className="context-menu-title">{menuPane.label}</div>
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
