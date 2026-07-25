import { PROMPT_TEMPLATES } from './promptTemplates'

export function NodeContextMenu({
  x,
  y,
  nodeId,
  onPick,
  onClose
}: {
  x: number
  y: number
  nodeId: string
  onPick: (promptText: string) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} onContextMenu={onClose} />
      <div className="context-menu" style={{ left: x, top: y }}>
        <div className="context-menu-title">{nodeId}</div>
        {PROMPT_TEMPLATES.map((t) => (
          <button key={t.id} onClick={() => onPick(t.build(nodeId))}>
            {t.label}
          </button>
        ))}
      </div>
    </>
  )
}
