import { EventEmitter } from 'events'
import { readFileSync, watch, watchFile, unwatchFile, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ClaudeSettingsState, EffortState } from '../../shared/types'

/**
 * Watches the user's global ~/.claude/settings.json and surfaces the bits we
 * badge on each terminal tab: the default model and the "thinking" /
 * reasoning-effort level (High, Extra High, Max, …).
 *
 * Claude Code persists both `model` and `effortLevel` (low|medium|high|xhigh)
 * here and rewrites the file whenever you change either in a session (`/model`,
 * Shift+Tab). `ultracode: true` is the CLI's "Max" tier and outranks effortLevel.
 * These are global to the CLI (shared by every running session).
 *
 * Reliability on Windows: the CLI often saves by atomic rename, which both
 * invalidates a file-scoped fs.watch after the first write and can be missed by
 * a directory watch. So we run two watchers — a directory fs.watch (fast) and a
 * polling watchFile (guaranteed) — and coalesce their events. Either one firing
 * re-reads the file; the read is cheap and only broadcasts on an actual change.
 */
export class SettingsWatcher extends EventEmitter {
  private dir = join(homedir(), '.claude')
  private file = join(this.dir, 'settings.json')
  private watcher: FSWatcher | null = null
  private polling = false
  private debounce: ReturnType<typeof setTimeout> | null = null
  private state: ClaudeSettingsState = { model: null, effort: { level: null, label: null } }

  start(): void {
    this.read()
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        if (name && name.toString() !== 'settings.json') return
        this.schedule()
      })
    } catch {
      // no ~/.claude dir yet (fresh machine) — the poll below still covers it
    }
    // 1s poll as a guaranteed fallback for atomic-rename writes fs.watch can miss
    watchFile(this.file, { interval: 1000 }, () => this.schedule())
    this.polling = true
  }

  get(): ClaudeSettingsState {
    return this.state
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.watcher = null
    if (this.polling) {
      unwatchFile(this.file)
      this.polling = false
    }
  }

  /** coalesce the burst of events an atomic save fires into one read */
  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.read(), 150)
  }

  private read(): void {
    const next = this.compute()
    if (
      next.model === this.state.model &&
      next.effort.level === this.state.effort.level &&
      next.effort.label === this.state.effort.label
    ) {
      return
    }
    this.state = next
    this.emit('change', next)
  }

  private compute(): ClaudeSettingsState {
    let settings: unknown
    try {
      settings = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // missing/unreadable/half-written file → treat as default
      return { model: null, effort: { level: null, label: null } }
    }
    const s = (settings ?? {}) as { model?: unknown; effortLevel?: unknown; ultracode?: unknown }
    const model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : null
    return { model, effort: this.effortOf(s) }
  }

  private effortOf(s: { effortLevel?: unknown; ultracode?: unknown }): EffortState {
    if (s.ultracode === true) return { level: 'max', label: 'Max' }
    const raw = typeof s.effortLevel === 'string' ? s.effortLevel.toLowerCase() : null
    switch (raw) {
      case 'low':
        return { level: 'low', label: 'Low' }
      case 'medium':
        return { level: 'medium', label: 'Medium' }
      case 'high':
        return { level: 'high', label: 'High' }
      case 'xhigh':
        return { level: 'xhigh', label: 'Extra High' }
      default:
        return { level: null, label: null }
    }
  }
}
