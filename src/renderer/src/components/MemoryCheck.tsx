import { useEffect, useRef, useState } from 'react'
import type { MemoryBank, MemoryScan } from '../../../shared/types'

/**
 * Startup memory check. On open it asks the main process to scan every Claude
 * Code memory bank on the machine, then animates a visible sweep through them so
 * the user can SEE that their cross-project memory was found and will be injected
 * into new terminals — instead of trusting the silent injection. Shown on first
 * open and re-openable from the header chip.
 */
export function MemoryCheck({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [scan, setScan] = useState<MemoryScan | null>(null)
  const [revealed, setRevealed] = useState(0)
  const [phase, setPhase] = useState<'searching' | 'done'>('searching')
  const [showDetails, setShowDetails] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    setPhase('searching')
    setRevealed(0)
    setScan(null)
    void window.api.scanMemory().then((s) => {
      if (cancelled) return
      setScan(s)
      if (!s.banks.length) {
        setPhase('done')
        return
      }
      // reveal banks one at a time so the search is actually visible; keep the
      // whole sweep under ~1.2s regardless of how many banks there are
      const stepMs = Math.max(80, Math.min(180, Math.floor(1200 / s.banks.length)))
      let i = 0
      timer.current = setInterval(() => {
        i += 1
        setRevealed(i)
        if (i >= s.banks.length) {
          if (timer.current) clearInterval(timer.current)
          timer.current = null
          setPhase('done')
        }
      }, stepMs)
    })
    return () => {
      cancelled = true
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }, [])

  const searching = phase === 'searching'
  const ok = scan?.ok ?? false
  const active = scan?.active ?? null
  const banks = scan?.banks ?? []
  const others = banks.filter((b) => !b.active)
  const primary = active ?? banks[0] ?? null
  const bankCount = banks.length
  const totalEntries = banks.reduce((n, b) => n + b.entries, 0)

  const bankRow = (b: MemoryBank, seen: boolean): React.JSX.Element => (
    <div className={`mem-bank${b.active ? ' active' : ''}${seen ? ' seen' : ''}`} key={b.key}>
      <span className="mem-bank-check">{seen ? '✓' : '…'}</span>
      <span className="mem-bank-key">{b.active ? 'Your cross-project memory (all projects)' : b.key}</span>
      <span className="mem-bank-meta">
        {b.entries} {b.entries === 1 ? 'entry' : 'entries'} · {b.files} file{b.files === 1 ? '' : 's'}
        {(b.hasIndex || b.files > 0) && ' · injected'}
      </span>
    </div>
  )

  return (
    <div className={`memory-check ${searching ? 'searching' : ok ? 'ok' : 'bad'}`}>
      <div className="memory-check-head">
        <span className="memory-check-icon">🧠</span>
        {searching ? (
          <span className="memory-check-title">
            <span className="mem-spinner" /> Searching all known memory banks…
          </span>
        ) : ok ? (
          <span className="memory-check-title">
            ✓ Your memory is loaded — <strong>{totalEntries}</strong> {totalEntries === 1 ? 'memory' : 'memories'} across{' '}
            <strong>{bankCount}</strong> {bankCount === 1 ? 'store' : 'stores'}, injected into every new terminal (the same
            context you have across all your plain Claude sessions).
          </span>
        ) : (
          <span className="memory-check-title">
            ⚠ No Claude memory found on this machine — new terminals won’t have any saved memory.
          </span>
        )}
        <span className="spacer" />
        {!searching && (
          <button className="icon-button" onClick={() => setShowDetails((v) => !v)} title="Show every memory bank found">
            {showDetails ? 'Hide details' : 'Details ▾'}
          </button>
        )}
        <button className="icon-button" onClick={onClose} title="Dismiss">
          ✕
        </button>
      </div>

      {/* during the sweep, reveal each bank as it's "checked" */}
      {searching && (
        <div className="mem-bank-list">{(scan?.banks ?? []).map((b, i) => bankRow(b, i < revealed))}</div>
      )}

      {!searching && ok && primary && (
        <div className="memory-check-body">
          <div className="mem-active-line">
            <code>{primary.dir}</code>
          </div>
          {primary.sampleTitles.length > 0 && (
            <div className="mem-recognize">
              Recognize it?{' '}
              {primary.sampleTitles.map((t, i) => (
                <span key={i} className="mem-title-chip">
                  “{t}”
                </span>
              ))}
              {primary.entries > primary.sampleTitles.length && (
                <span className="mem-more"> +{primary.entries - primary.sampleTitles.length} more</span>
              )}
            </div>
          )}
          {others.length > 0 && (
            <div className="mem-others-note">
              Plus {others.length} more project memory store{others.length === 1 ? '' : 's'} — a normal `claude` session
              only sees one at a time, so this app injects all {bankCount} together to give you everything at once.
            </div>
          )}
          {scan?.injectedTokensApprox != null && (
            <div className="mem-others-note">
              Injected into every terminal: ~{scan.injectedTokensApprox.toLocaleString()} tokens (graph protocol +{' '}
              {bankCount} memory {bankCount === 1 ? 'store' : 'stores'}). It's a stable prefix, so after the first turn
              it's served from cache (~10× cheaper) rather than re-billed.
            </div>
          )}
        </div>
      )}

      {!searching && !ok && (
        <div className="memory-check-body">
          <p className="mem-bad-reason">{scan?.reason}</p>
          <p className="mem-bad-hint">
            Save a memory from any Claude session (it writes to your home memory store), then reopen this app — the
            check will turn green.
          </p>
        </div>
      )}

      {!searching && showDetails && (
        <div className="mem-bank-list details">
          {(scan?.banks ?? []).map((b) => bankRow(b, true))}
          <div className="mem-config-dir">Searched: {scan?.configDir}</div>
        </div>
      )}
    </div>
  )
}
