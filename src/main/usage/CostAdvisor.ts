import type { CostSuggestion, CostSuggestionKind, TermUsage } from '../../shared/types'
import { analyze, compareSuggestions, type UsageSample } from './advisor'

/** ~40 min of history at the 10s OTEL export cadence — enough for every detector. */
const MAX_HISTORY = 240
/** clear a suggestion only after it's been absent this many records — hysteresis
 *  so a session hovering at a threshold doesn't flap the card on and off. */
const CLEAR_MISS_STREAK = 3

interface TermState {
  history: UsageSample[]
  /** kinds the user dismissed this session — never re-shown */
  dismissed: Set<CostSuggestionKind>
  /** live suggestions, with a miss counter driving hysteresis */
  active: Map<CostSuggestionKind, { s: CostSuggestion; miss: number }>
  /** signature of the last broadcast, so we only emit on real change */
  lastSig: string
}

/**
 * Turns the per-session token stream into a de-duplicated, hysteresis-smoothed,
 * dismissal-aware set of cost suggestions. Holds the history the pure `analyze`
 * needs (the UsageTracker keeps only the latest cumulative value) and broadcasts
 * a session's suggestion list only when it actually changes.
 */
export class CostAdvisor {
  private terms = new Map<string, TermState>()

  constructor(private onChange: (termId: string, suggestions: CostSuggestion[]) => void) {}

  /** Feed one usage update; recomputes and (if changed) broadcasts suggestions. */
  record(u: TermUsage, now: number, billingReal: boolean): void {
    const st = this.get(u.termId)
    st.history.push({
      t: now,
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation: u.cacheCreationTokens,
      cost: u.costUsd,
      model: u.model
    })
    if (st.history.length > MAX_HISTORY) st.history.shift()

    const found = analyze({ termId: u.termId, now, billingReal, history: st.history })
    const foundKinds = new Set(found.map((s) => s.kind))

    for (const s of found) {
      if (st.dismissed.has(s.kind)) continue
      st.active.set(s.kind, { s, miss: 0 })
    }
    for (const [kind, rec] of st.active) {
      if (!foundKinds.has(kind)) {
        rec.miss += 1
        if (rec.miss >= CLEAR_MISS_STREAK) st.active.delete(kind)
      }
    }
    this.emit(u.termId, st)
  }

  /** User dismissed a suggestion — hide it and don't resurface it this session. */
  dismiss(termId: string, kind: CostSuggestionKind): void {
    const st = this.terms.get(termId)
    if (!st) return
    st.dismissed.add(kind)
    st.active.delete(kind)
    this.emit(termId, st)
  }

  untrack(termId: string): void {
    this.terms.delete(termId)
  }

  private emit(termId: string, st: TermState): void {
    const list = [...st.active.values()].map((r) => r.s).sort(compareSuggestions)
    const sig = list.map((s) => `${s.kind}:${s.severity}:${s.savingsLowPct}-${s.savingsHighPct}`).join('|')
    if (sig === st.lastSig) return
    st.lastSig = sig
    this.onChange(termId, list)
  }

  private get(termId: string): TermState {
    let st = this.terms.get(termId)
    if (!st) {
      st = { history: [], dismissed: new Set(), active: new Map(), lastSig: '' }
      this.terms.set(termId, st)
    }
    return st
  }
}
