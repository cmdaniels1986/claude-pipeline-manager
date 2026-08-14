import { useState } from 'react'
import type { CostSuggestion } from '../../../shared/types'
import { useTerminalStore } from '../stores/terminalStore'

const SEV_LABEL: Record<CostSuggestion['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' }
const CONF_LABEL: Record<CostSuggestion['confidence'], string> = {
  high: 'high confidence',
  med: 'medium confidence',
  low: 'low confidence'
}

/**
 * One cost-saving suggestion about this terminal. Follows the design study:
 * savings and confidence are shown as SEPARATE axes, the finding is a typed
 * one-liner, the fix (if any) is one click, and "why am I seeing this?" reveals
 * the evidence so the call isn't a black box.
 */
function Card({ s }: { s: CostSuggestion }): React.JSX.Element {
  const [why, setWhy] = useState(false)
  const [applying, setApplying] = useState(false)

  const apply = async (): Promise<void> => {
    if (!s.action) return
    setApplying(true)
    await window.api.advisorApply(s.termId, s.action)
    // the card clears itself once the metric recovers — leave it until then
    setApplying(false)
  }

  return (
    <div className={`cost-card sev-${s.severity}`}>
      <div className="cost-row">
        <span className="cost-ico">💡</span>
        <span className="cost-finding">{s.finding}</span>
        <span className={`cost-chip sev-chip-${s.severity}`}>{SEV_LABEL[s.severity]}</span>
        <span className="cost-save" title={`Basis: ${s.basis}`}>
          ≈{s.savingsLowPct}–{s.savingsHighPct}% cheaper/turn
        </span>
        <span className="spacer" />
        <button
          className="icon-button"
          title="Mute this tip — never show it again"
          onClick={() => void window.api.advisorDismiss(s.termId, s.kind, 'mute')}
        >
          🔕
        </button>
        <button
          className="icon-button"
          title="Dismiss for now (repeatedly dismissing retires the tip)"
          onClick={() => void window.api.advisorDismiss(s.termId, s.kind, 'session')}
        >
          ✕
        </button>
      </div>
      <div className="cost-detail">{s.detail}</div>
      <div className="cost-actions">
        {s.action && (
          <button className="primary" disabled={applying} onClick={() => void apply()}>
            {applying ? 'Sending…' : s.action.label}
          </button>
        )}
        <button className="link-button" onClick={() => setWhy((v) => !v)}>
          {why ? 'Hide details' : 'Why am I seeing this?'}
        </button>
        <span className="cost-conf">{CONF_LABEL[s.confidence]}</span>
      </div>
      {why && (
        <ul className="cost-why">
          {s.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
          <li className="cost-basis">Savings basis: {s.basis}</li>
        </ul>
      )}
    </div>
  )
}

/** Passive panel of cost suggestions for one terminal — renders nothing when
 *  there are none (the common, healthy case). */
export function CostAdvisorBar({ termId }: { termId: string }): React.JSX.Element | null {
  const suggestions = useTerminalStore((s) => s.suggestions[termId])
  if (!suggestions || suggestions.length === 0) return null
  return (
    <div className="cost-advisor">
      {suggestions.map((s) => (
        <Card key={s.id} s={s} />
      ))}
    </div>
  )
}
