import { useEffect, useRef } from 'react'
import { useTerminalStore } from '../stores/terminalStore'
import { TerminalPane } from './TerminalPane'

/** Shell for a popped-out terminal window (#/term/<termId>?label=..&cwd=..). */
export default function TermWindowApp(): React.JSX.Element {
  const hash = window.location.hash // "#/term/<id>?label=..&cwd=.."
  const [path, query = ''] = hash.slice(1).split('?')
  const termId = path.split('/')[2] ?? ''
  const params = new URLSearchParams(query)
  const label = params.get('label') ?? 'claude'
  const cwd = params.get('cwd') ?? ''
  const color = params.get('color') ?? undefined

  const adoptPane = useTerminalStore((s) => s.adoptPane)
  const pane = useTerminalStore((s) => s.panes.find((p) => p.termId === termId))
  const hadPane = useRef(false)
  if (pane) hadPane.current = true

  useEffect(() => {
    if (!termId) return
    adoptPane({ termId, label, cwd, color })
    // claim AFTER the pane mounted so no output slips past the buffer
    void window.api.termClaim(termId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  useEffect(() => {
    document.title = label
  }, [label])

  // pane removed (session closed via the ✕) → close the OS window too
  useEffect(() => {
    if (termId && !pane && hadPane.current) window.close()
  }, [termId, pane])

  if (!pane) {
    return <div className="empty-state">Attaching…</div>
  }

  return (
    <div className="app-shell term-window">
      <TerminalPane pane={pane} isActive showHeader />
    </div>
  )
}
