import { stripAnsi } from '../usage/limitDetect'

/**
 * "Is Claude working in this terminal?" from the PTY output stream.
 *
 * Claude Code shows an "esc to interrupt" hint in its status line for the whole
 * time a turn is running (thinking, streaming a reply, running a tool) and drops
 * it at the idle prompt. The spinner redraws that line several times a second,
 * so seeing the marker means the session is busy; when the marker stops arriving
 * for a beat, the turn is done. This is a heuristic on TUI text — the same class
 * of scrape as the usage-limit detector — so it degrades to "idle" if the CLI
 * ever changes that wording, never to a wrong "busy".
 */
const WORKING_RE = /esc to interrupt/i

/** True if `text` (raw PTY output) shows Claude actively working. */
export function detectWorking(text: string): boolean {
  return WORKING_RE.test(stripAnsi(text))
}

type Timer = ReturnType<typeof setTimeout>

export interface ActivityMonitorOptions {
  /** called only when a terminal's busy state actually flips */
  onChange: (termId: string, busy: boolean) => void
  /** how long with no "working" marker before a terminal is called idle again
   *  (must exceed the spinner's redraw gap; default 1.5s) */
  idleMs?: number
  /** injectable timers for tests */
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (t: Timer) => void
}

interface TermActivity {
  busy: boolean
  timer: Timer | null
  /** tail of the previous stripped chunk, so a marker split across two data
   *  events ("…esc to inter" + "rupt…") still matches */
  carry: string
}

// longer than the marker so any split of it is bridged
const CARRY = 24

export class ActivityMonitor {
  private terms = new Map<string, TermActivity>()
  private onChange: (termId: string, busy: boolean) => void
  private idleMs: number
  private setTimer: (fn: () => void, ms: number) => Timer
  private clearTimer: (t: Timer) => void

  constructor(opts: ActivityMonitorOptions) {
    this.onChange = opts.onChange
    this.idleMs = opts.idleMs ?? 1500
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t))
  }

  /** Feed a terminal's raw output chunk. */
  observe(termId: string, data: string): void {
    const st = this.terms.get(termId) ?? this.init(termId)
    const clean = st.carry + stripAnsi(data)
    st.carry = clean.slice(-CARRY)
    if (!WORKING_RE.test(clean)) return
    // saw Claude working → (re)arm the idle timer and flip busy on if needed
    if (st.timer) this.clearTimer(st.timer)
    st.timer = this.setTimer(() => this.markIdle(termId), this.idleMs)
    if (!st.busy) {
      st.busy = true
      this.onChange(termId, true)
    }
  }

  /** A terminal exited (or was disposed): force idle and drop its state. */
  end(termId: string): void {
    const st = this.terms.get(termId)
    if (!st) return
    if (st.timer) this.clearTimer(st.timer)
    const wasBusy = st.busy
    this.terms.delete(termId)
    if (wasBusy) this.onChange(termId, false)
  }

  dispose(): void {
    for (const st of this.terms.values()) if (st.timer) this.clearTimer(st.timer)
    this.terms.clear()
  }

  private init(termId: string): TermActivity {
    const st: TermActivity = { busy: false, timer: null, carry: '' }
    this.terms.set(termId, st)
    return st
  }

  private markIdle(termId: string): void {
    const st = this.terms.get(termId)
    if (!st) return
    st.timer = null
    if (st.busy) {
      st.busy = false
      this.onChange(termId, false)
    }
  }
}
