import type { ResumeState } from '../../shared/types'
import { detectUsageLimit } from './limitDetect'

const BUFFER_CAP = 2500
const DRAIN_PACE_MS = 1200 // gap between draining consecutive queued prompts
const RESUME_BOOT_MS = 3000 // let a relaunched session boot before injecting
const RESET_GRACE_MS = 3000 // send a little after the stated reset time
const FALLBACK_RETRY_MS = 10 * 60_000 // retry cadence when the reset time couldn't be parsed
const MAX_WAIT_MS = 8 * 60 * 60_000 // never schedule further out than this
// cheap pre-filter before running full detection; must cover every wording family
// detectUsageLimit can match (incl. the 2.1.x "out of usage credits" system)
const HINT = /hit your|usage limit|limit reached|out of usage|usage credits/i

export interface ResumeDeps {
  inject: (termId: string, text: string) => void
  relaunchResume: (termId: string) => boolean
  isAlive: (termId: string) => boolean
  onState: (state: ResumeState) => void
  /** a dead session was relaunched to continue — let the UI flip it back to live */
  onResumed: (termId: string) => void
}

interface Rec {
  termId: string
  queue: string[]
  lastSent: string | null
  limited: boolean
  resetAt: number | null
  resetLabel: string | null
  buffer: string
  timer: NodeJS.Timeout | null
  drainTimer: NodeJS.Timeout | null
}

/**
 * Per-terminal prompt queue + usage-limit auto-resume. Prompts are enqueued (only
 * ever app-injected prompts, never scraped keystrokes); they drain into the
 * terminal when usage is available. When a session hits its usage limit we detect
 * it from the output, hold the queue (re-queuing the blocked prompt), and at reset
 * we relaunch the session with --resume if it died, then drain.
 */
export class ResumeManager {
  private recs = new Map<string, Rec>()

  constructor(private deps: ResumeDeps) {}

  private rec(termId: string): Rec {
    let r = this.recs.get(termId)
    if (!r) {
      r = {
        termId,
        queue: [],
        lastSent: null,
        limited: false,
        resetAt: null,
        resetLabel: null,
        buffer: '',
        timer: null,
        drainTimer: null
      }
      this.recs.set(termId, r)
    }
    return r
  }

  states(): ResumeState[] {
    return [...this.recs.values()].map(toState)
  }

  /** Queue a prompt. Sends right away if usage is available, else holds for reset. */
  enqueue(termId: string, text: string): void {
    const t = text.trim()
    if (!t) return
    const r = this.rec(termId)
    r.queue.push(t)
    this.emit(r)
    if (!r.limited) this.scheduleDrain(r, 0)
  }

  /** Feed raw PTY output so we can spot a usage-limit block. */
  observe(termId: string, data: string): void {
    const r = this.rec(termId)
    r.buffer = (r.buffer + data).slice(-BUFFER_CAP)
    if (r.limited) return
    if (!HINT.test(data) && !HINT.test(r.buffer)) return
    const info = detectUsageLimit(r.buffer)
    if (info) this.enterLimited(r, info.resetAt, info.resetLabel)
  }

  /** Resume now, skipping the wait (user pressed "Resume now"). */
  resumeNow(termId: string): void {
    const r = this.recs.get(termId)
    if (r) this.resume(r)
  }

  /** Stop waiting and clear the queue (user pressed "Cancel"). */
  cancel(termId: string): void {
    const r = this.recs.get(termId)
    if (!r) return
    this.clearTimers(r)
    r.limited = false
    r.resetAt = null
    r.resetLabel = null
    r.queue = []
    r.lastSent = null
    r.buffer = ''
    this.emit(r)
  }

  onExit(termId: string): void {
    // If it exited while limited we keep waiting — resume() will relaunch it.
    // Nothing to do here otherwise; a dead session just won't drain.
    void termId
  }

  dispose(termId: string): void {
    const r = this.recs.get(termId)
    if (r) this.clearTimers(r)
    this.recs.delete(termId)
  }

  disposeAll(): void {
    for (const r of this.recs.values()) this.clearTimers(r)
    this.recs.clear()
  }

  private enterLimited(r: Rec, resetAt: number | null, resetLabel: string): void {
    r.limited = true
    r.resetAt = resetAt
    r.resetLabel = resetLabel
    // the prompt that triggered the limit was rejected by the CLI — replay it first
    if (r.lastSent) {
      r.queue.unshift(r.lastSent)
      r.lastSent = null
    }
    this.clearTimers(r)
    const delay =
      resetAt != null
        ? Math.min(Math.max(resetAt - Date.now() + RESET_GRACE_MS, 0), MAX_WAIT_MS)
        : FALLBACK_RETRY_MS
    r.timer = setTimeout(() => this.resume(r), delay)
    this.emit(r)
  }

  private resume(r: Rec): void {
    this.clearTimers(r)
    r.limited = false
    r.resetAt = null
    r.resetLabel = null
    r.buffer = ''
    const wasAlive = this.deps.isAlive(r.termId)
    if (!wasAlive) {
      this.deps.relaunchResume(r.termId)
      this.deps.onResumed(r.termId)
    }
    this.emit(r)
    this.scheduleDrain(r, wasAlive ? 0 : RESUME_BOOT_MS)
  }

  private scheduleDrain(r: Rec, delay: number): void {
    if (r.drainTimer) clearTimeout(r.drainTimer)
    r.drainTimer = setTimeout(() => this.drain(r), delay)
  }

  private drain(r: Rec): void {
    r.drainTimer = null
    if (r.limited || r.queue.length === 0) return
    if (!this.deps.isAlive(r.termId)) return // can't send into a dead session
    const next = r.queue.shift() as string
    r.lastSent = next
    this.deps.inject(r.termId, next)
    this.emit(r)
    if (r.queue.length) this.scheduleDrain(r, DRAIN_PACE_MS)
  }

  private clearTimers(r: Rec): void {
    if (r.timer) clearTimeout(r.timer)
    if (r.drainTimer) clearTimeout(r.drainTimer)
    r.timer = null
    r.drainTimer = null
  }

  private emit(r: Rec): void {
    this.deps.onState(toState(r))
  }
}

function toState(r: Rec): ResumeState {
  return {
    termId: r.termId,
    limited: r.limited,
    resetAt: r.resetAt,
    resetLabel: r.resetLabel,
    queue: [...r.queue]
  }
}
