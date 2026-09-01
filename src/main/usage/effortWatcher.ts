import { EventEmitter } from 'events'
import { readFileSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { EffortState } from '../../shared/types'

/**
 * Watches the user's global ~/.claude/settings.json and surfaces the current
 * "thinking" / reasoning-effort level (High, Extra High, Max, …).
 *
 * Claude Code persists the level as `effortLevel` (low|medium|high|xhigh) and
 * rewrites that file whenever you cycle thinking with Shift+Tab, so a file watch
 * gives us a live signal. `ultracode: true` is the CLI's "Max" tier and outranks
 * effortLevel. The value is global to the CLI (shared by every running session),
 * so we track a single state rather than one per terminal.
 *
 * We watch the containing directory, not the file: editors and the CLI often
 * save by atomic rename, which invalidates a file-scoped fs.watch after the
 * first write.
 */
export class EffortWatcher extends EventEmitter {
  private dir = join(homedir(), '.claude')
  private file = join(this.dir, 'settings.json')
  private watcher: FSWatcher | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private state: EffortState = { level: null, label: null }

  start(): void {
    this.read()
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        if (name && name.toString() !== 'settings.json') return
        if (this.debounce) clearTimeout(this.debounce)
        // coalesce the burst of events an atomic save fires
        this.debounce = setTimeout(() => this.read(), 150)
      })
    } catch {
      // no ~/.claude dir yet (fresh machine) — we simply report the default
    }
  }

  get(): EffortState {
    return this.state
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.watcher = null
  }

  private read(): void {
    const next = this.compute()
    if (next.level === this.state.level && next.label === this.state.label) return
    this.state = next
    this.emit('change', next)
  }

  private compute(): EffortState {
    let settings: unknown
    try {
      settings = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // missing/unreadable/half-written file → treat as default (no badge)
      return { level: null, label: null }
    }
    const s = (settings ?? {}) as { effortLevel?: unknown; ultracode?: unknown }
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
