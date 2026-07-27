import { useEffect, useState } from 'react'
import { useTerminalStore } from '../stores/terminalStore'

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'any moment'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

export function ResumeBar({
  termId,
  forceOpen,
  onClose
}: {
  termId: string
  forceOpen: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const state = useTerminalStore((s) => s.resume[termId])
  const [text, setText] = useState('')
  const [, tick] = useState(0)

  const limited = state?.limited ?? false
  const resetAt = state?.resetAt ?? null

  // re-render every second so the countdown stays live
  useEffect(() => {
    if (!limited || resetAt == null) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [limited, resetAt])

  const queue = state?.queue ?? []
  if (!limited && queue.length === 0 && !forceOpen) return null

  const add = (): void => {
    const t = text.trim()
    if (!t) return
    void window.api.promptInject({ termId, text: t })
    setText('')
  }

  const remaining = resetAt != null ? resetAt - Date.now() : null

  return (
    <div className={`resume-bar${limited ? ' limited' : ''}`}>
      <div className="resume-row">
        {limited ? (
          <span className="resume-status">
            ⏳ {state?.resetLabel ?? 'Usage limit reached'} —{' '}
            {remaining != null ? `auto-resuming in ${fmtCountdown(remaining)}` : 'auto-resuming when it resets'}
          </span>
        ) : queue.length > 0 ? (
          <span className="resume-status running">▶ Sending queued prompt{queue.length > 1 ? 's' : ''}…</span>
        ) : (
          <span className="resume-status">⧗ Prompt queue — runs now, or after your usage limit resets</span>
        )}
        {queue.length > 0 && <span className="resume-count">{queue.length} queued</span>}
        <span className="spacer" />
        {limited && (
          <button onClick={() => void window.api.resumeNow(termId)} title="Try to resume right now">
            Resume now
          </button>
        )}
        {limited ? (
          <button
            className="icon-button"
            onClick={() => void window.api.resumeCancel(termId)}
            title="Stop waiting and clear the queue"
          >
            ✕
          </button>
        ) : (
          <button className="icon-button" onClick={onClose} title="Hide">
            ▾
          </button>
        )}
      </div>

      {queue.length > 0 && (
        <ol className="resume-queue">
          {queue.map((q, i) => (
            <li key={i} title={q}>
              {q}
            </li>
          ))}
        </ol>
      )}

      <div className="resume-add">
        <input
          value={text}
          placeholder={limited ? 'Queue another prompt to run after reset…' : 'Queue a prompt…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="primary" onClick={add} disabled={!text.trim()}>
          Queue
        </button>
      </div>
    </div>
  )
}
