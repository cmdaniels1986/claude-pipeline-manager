import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { CostSuggestionKind, DismissMode } from '../../shared/types'

/**
 * Remembers how the user has dismissed each suggestion KIND, persisted across
 * app restarts, so the advisor doesn't become nagware (design study §5.4):
 *   - a plain dismiss soft-hides that kind briefly (anti-flap across terminals)
 *     and counts toward auto-retire;
 *   - after enough dismissals a kind auto-retires (never shown again);
 *   - an explicit "mute" retires it immediately; a "snooze" hides it for a while.
 * Suppression is per-kind (a learning signal), independent of the per-terminal
 * "hide this card now" that CostAdvisor also applies.
 */
const AUTO_RETIRE_N = 3 // a kind dismissed this many times overall → retire it
const SOFT_SNOOZE_MS = 60 * 60_000 // each plain dismiss hides the kind for an hour
const SNOOZE_MS = 24 * 60 * 60_000 // an explicit snooze hides it for a day

interface KindRec {
  count: number
  lastAt: number
  mutedUntil?: number
  muted?: boolean
}

interface Persisted {
  version: 1
  kinds: Partial<Record<CostSuggestionKind, KindRec>>
}

export class DismissalStore {
  private data: Persisted

  /** `filePath` omitted → in-memory only (used by tests). */
  constructor(private filePath?: string) {
    this.data = this.load()
  }

  /** True when this kind should be withheld right now. */
  isSuppressed(kind: CostSuggestionKind, now: number): boolean {
    const k = this.data.kinds[kind]
    if (!k) return false
    if (k.muted) return true
    if (k.count >= AUTO_RETIRE_N) return true
    if (k.mutedUntil != null && now < k.mutedUntil) return true
    return false
  }

  /** Record a dismissal and update suppression state. */
  record(kind: CostSuggestionKind, mode: DismissMode, now: number): void {
    const k = this.data.kinds[kind] ?? { count: 0, lastAt: 0 }
    k.count += 1
    k.lastAt = now
    if (mode === 'mute') k.muted = true
    else if (mode === 'snooze') k.mutedUntil = Math.max(k.mutedUntil ?? 0, now + SNOOZE_MS)
    else k.mutedUntil = Math.max(k.mutedUntil ?? 0, now + SOFT_SNOOZE_MS)
    this.data.kinds[kind] = k
    this.save()
  }

  private load(): Persisted {
    if (this.filePath && existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Persisted
        if (parsed && parsed.kinds) return { version: 1, kinds: parsed.kinds }
      } catch {
        // corrupt file — start clean
      }
    }
    return { version: 1, kinds: {} }
  }

  private save(): void {
    if (!this.filePath) return
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data))
    } catch {
      // best-effort; a failed write just means it won't survive a restart
    }
  }
}
