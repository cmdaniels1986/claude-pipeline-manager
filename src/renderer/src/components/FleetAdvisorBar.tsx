import { useState } from 'react'
import type { FleetSuggestion } from '../../../shared/types'
import { useTerminalStore } from '../stores/terminalStore'

const SEV_LABEL: Record<FleetSuggestion['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' }

/**
 * The one cross-terminal cost card — currently "N terminals on Opus at once",
 * the burn a single Claude Code session can't see. App-level (not per-terminal),
 * so it lives in the header banner area. Dismiss hides the current condition
 * until it materially changes (its signature moves).
 */
export function FleetAdvisorBar(): React.JSX.Element | null {
  const fleet = useTerminalStore((s) => s.fleet)
  const [hiddenSig, setHiddenSig] = useState<string | null>(null)
  const [why, setWhy] = useState(false)
  if (!fleet || fleet.sig === hiddenSig) return null

  return (
    <div className={`cost-advisor fleet sev-${fleet.severity}`}>
      <div className={`cost-card sev-${fleet.severity}`}>
        <div className="cost-row">
          <span className="cost-ico">🛰️</span>
          <span className="cost-finding">{fleet.finding}</span>
          <span className={`cost-chip sev-chip-${fleet.severity}`}>{SEV_LABEL[fleet.severity]}</span>
          <span className="cost-save">~{Math.round(fleet.combinedBurnPerMin / 1000)}k tok/min combined</span>
          <span className="spacer" />
          <button
            className="icon-button"
            title="Dismiss until this changes"
            onClick={() => setHiddenSig(fleet.sig)}
          >
            ✕
          </button>
        </div>
        <div className="cost-detail">{fleet.detail}</div>
        <div className="cost-actions">
          <button className="link-button" onClick={() => setWhy((v) => !v)}>
            {why ? 'Hide details' : 'Which terminals?'}
          </button>
        </div>
        {why && (
          <ul className="cost-why">
            {fleet.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            <li className="cost-basis">Basis: {fleet.basis}</li>
          </ul>
        )}
      </div>
    </div>
  )
}
