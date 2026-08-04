import { useState } from 'react'
import { PROMPT_TEMPLATES } from './promptTemplates'

export interface Provenance {
  label: string
  color?: string
}

export function NodeContextMenu({
  x,
  y,
  nodeId,
  path,
  owner,
  lastTouched,
  onPick,
  onOpenFile,
  onReveal,
  onSetOwner,
  onClose
}: {
  x: number
  y: number
  nodeId: string
  path?: string
  owner?: string
  lastTouched?: Provenance | null
  onPick: (promptText: string) => void
  onOpenFile: () => void
  onReveal: () => void
  onSetOwner: (owner: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [ownerText, setOwnerText] = useState(owner ?? '')

  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} onContextMenu={onClose} />
      <div className="context-menu" style={{ left: x, top: y }}>
        <div className="context-menu-title">{nodeId}</div>
        <div className="context-menu-meta">
          <div className="ctx-path">{path ? path : 'no source file recorded'}</div>
          {lastTouched && (
            <div className="ctx-prov">
              <span className="agent-color-dot" style={{ background: lastTouched.color ?? '#8b949e' }} />
              last touched by {lastTouched.label}
            </div>
          )}
        </div>

        <button disabled={!path} onClick={onOpenFile}>
          📄 Open source file
        </button>
        <button disabled={!path} onClick={onReveal}>
          📂 Reveal in folder
        </button>

        <div className="context-menu-divider" />

        <div className="ctx-owner">
          <span className="ctx-owner-label">👤 owner</span>
          <input
            className="ctx-owner-input"
            value={ownerText}
            onChange={(e) => setOwnerText(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSetOwner(ownerText)
              else if (e.key === 'Escape') onClose()
            }}
            placeholder="unassigned"
            maxLength={60}
          />
          <button
            className="ctx-owner-save"
            onClick={() => onSetOwner(ownerText)}
            title="Save owner (Enter)"
          >
            ✓
          </button>
        </div>

        <div className="context-menu-divider" />

        {PROMPT_TEMPLATES.map((t) => (
          <button key={t.id} onClick={() => onPick(t.build(nodeId))}>
            {t.label}
          </button>
        ))}
      </div>
    </>
  )
}
