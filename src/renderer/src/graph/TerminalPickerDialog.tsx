import { useEffect, useState } from 'react'
import type { TermInfo } from '../../../shared/types'

export function TerminalPickerDialog({
  promptText,
  onDone,
  onClose
}: {
  promptText: string
  onDone: (label: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [terms, setTerms] = useState<TermInfo[] | null>(null)

  useEffect(() => {
    void window.api.termList().then((list) => setTerms(list.filter((t) => t.alive)))
  }, [])

  const send = async (term: TermInfo): Promise<void> => {
    await window.api.promptInject({ termId: term.termId, text: promptText, autoSubmit: true })
    onDone(term.label)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Send to which terminal?</h3>
        <p className="modal-note prompt-preview">{promptText}</p>
        {terms === null ? (
          <p>Loading…</p>
        ) : terms.length === 0 ? (
          <p>No live terminals. Launch one in the main window first.</p>
        ) : (
          <div className="term-picker-list">
            {terms.map((t) => (
              <button key={t.termId} onClick={() => void send(t)} title={t.cwd}>
                <span
                  className="agent-color-dot"
                  style={{ background: t.color ?? '#8b949e' }}
                />
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
