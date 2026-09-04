import { watch, type FSWatcher } from 'chokidar'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PreviewCandidate, PreviewReload, PreviewSource, PreviewState } from '../../shared/types'
import { stripAnsi } from '../usage/limitDetect'
import { detectLocalUrls, normalizeLocalUrl } from './urlDetect'

export interface PreviewManagerOptions {
  onChange: (state: PreviewState) => void
  onReload: (reload: PreviewReload) => void
  /** ports owned by the app itself, never offered as a preview */
  excludePorts: () => number[]
}

interface Persisted {
  version: 1
  url: string | null
  label: string | null
  source: PreviewSource | null
  selectedAt: string | null
}

/** tail of the previous chunk kept so a URL split across two PTY reads still matches */
const CARRY = 96
/** re-seeing the same URL inside this window doesn't re-announce it */
const DEDUP_MS = 30_000
const MAX_CANDIDATES = 8
/** folders whose churn is never a reason to reload the page */
const IGNORED_DIRS =
  /(^|[\\/])(node_modules|\.git|\.claude-manager|\.claude|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.cache|__pycache__|\.venv|venv|\.pytest_cache|\.mypy_cache|coverage|\.idea|\.vscode)([\\/]|$)/

/**
 * Per-project state behind the live preview pane: which local URL to show, the
 * dev-server URLs recently seen in terminal output (or announced by agents via
 * the preview_* MCP tools), and a project-folder watcher that asks the pane to
 * reload for stacks without hot-module reload (Flask, Django, static sites).
 * The pane itself lives in the renderer as a <webview>; this only decides *what*
 * it shows and *when* it should refresh.
 */
export class PreviewManager {
  private root: string | null = null
  private url: string | null = null
  private label: string | null = null
  private source: PreviewSource | null = null
  private selectedAt: string | null = null
  private candidates: PreviewCandidate[] = []
  private carry = new Map<string, string>()
  private lastSeen = new Map<string, number>()
  private watcher: FSWatcher | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPath: string | null = null

  constructor(private opts: PreviewManagerOptions) {}

  /** Switch to a project: restore its last preview URL, drop the old candidates + watcher. */
  setRoot(root: string): void {
    if (this.root === root) return
    this.root = root
    this.candidates = []
    this.lastSeen.clear()
    this.carry.clear()
    void this.watcher?.close()
    this.watcher = null
    const saved = this.load()
    this.url = saved?.url ?? null
    this.label = saved?.label ?? null
    this.source = saved?.source ?? null
    this.selectedAt = saved?.selectedAt ?? null
    this.syncWatcher()
    this.emit()
  }

  get(): PreviewState {
    return {
      url: this.url,
      label: this.label,
      source: this.source,
      selectedAt: this.selectedAt,
      candidates: [...this.candidates]
    }
  }

  /** Point the pane at a URL. Returns the canonical URL, or null if it isn't a local http(s) URL. */
  set(raw: string, source: PreviewSource, termId: string | null, label?: string): string | null {
    const url = normalizeLocalUrl(raw)
    if (!url) return null
    this.url = url
    this.label = label?.trim() || null
    this.source = source
    this.selectedAt = new Date().toISOString()
    this.remember(url, termId, label, /* force */ true)
    this.save()
    this.syncWatcher()
    this.emit()
    return url
  }

  clear(): void {
    this.url = null
    this.label = null
    this.source = null
    this.selectedAt = null
    this.save()
    this.syncWatcher()
    this.emit()
  }

  /** An agent asked for a refresh (e.g. after editing a template a non-HMR server serves). */
  reload(termId: string | null): void {
    this.opts.onReload({ reason: 'agent', termId })
  }

  /** Feed a terminal's raw output; any dev-server URL it prints becomes a candidate, and the
   *  first one seen while nothing is selected is adopted automatically. */
  observe(termId: string, data: string): void {
    const clean = (this.carry.get(termId) ?? '') + stripAnsi(data)
    this.carry.set(termId, clean.slice(-CARRY))
    // cheap pre-filter before the regex walk
    if (!clean.includes('://')) return
    // a URL cut off at the chunk edge waits in `carry` for the rest to arrive
    const urls = detectLocalUrls(clean, { excludePorts: this.opts.excludePorts(), holdTrailing: true })
    if (!urls.length) return
    let changed = false
    for (const url of urls) {
      if (this.remember(url, termId, undefined, false)) changed = true
    }
    if (!this.url && urls[0]) {
      this.url = urls[0]
      this.label = null
      this.source = 'detected'
      this.selectedAt = new Date().toISOString()
      this.save()
      this.syncWatcher()
      changed = true
    }
    if (changed) this.emit()
  }

  dispose(): void {
    void this.watcher?.close()
    this.watcher = null
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
  }

  /** Add/refresh a candidate. Returns true when the list actually changed. */
  private remember(url: string, termId: string | null, label: string | undefined, force: boolean): boolean {
    const now = Date.now()
    const last = this.lastSeen.get(url) ?? 0
    if (!force && now - last < DEDUP_MS) return false
    this.lastSeen.set(url, now)
    const existing = this.candidates.find((c) => c.url === url)
    const entry: PreviewCandidate = {
      url,
      termId,
      label: label?.trim() || existing?.label,
      ts: new Date(now).toISOString()
    }
    this.candidates = [entry, ...this.candidates.filter((c) => c.url !== url)].slice(0, MAX_CANDIDATES)
    return true
  }

  /** Watch the project folder only while something is being previewed. */
  private syncWatcher(): void {
    const want = !!(this.root && this.url)
    if (!want) {
      void this.watcher?.close()
      this.watcher = null
      return
    }
    if (this.watcher) return
    try {
      this.watcher = watch(this.root!, {
        ignoreInitial: true,
        ignored: (path: string) => IGNORED_DIRS.test(path),
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
      })
      this.watcher.on('all', (_event, path) => this.scheduleReload(path))
      this.watcher.on('error', () => {})
    } catch {
      this.watcher = null
    }
  }

  private scheduleReload(path: string): void {
    this.pendingPath = path
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    // coalesce a burst of writes (an agent editing several files) into one reload
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      this.opts.onReload({ reason: 'files', path: this.pendingPath ?? undefined })
      this.pendingPath = null
    }, 600)
  }

  private emit(): void {
    this.opts.onChange(this.get())
  }

  private filePath(): string | null {
    return this.root ? join(this.root, '.claude-manager', 'preview.json') : null
  }

  private load(): Persisted | null {
    const p = this.filePath()
    if (!p || !existsSync(p)) return null
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Persisted>
      if (raw?.version !== 1) return null
      const url = typeof raw.url === 'string' ? normalizeLocalUrl(raw.url) : null
      return {
        version: 1,
        url,
        label: typeof raw.label === 'string' ? raw.label : null,
        source: url ? (raw.source ?? 'manual') : null,
        selectedAt: typeof raw.selectedAt === 'string' ? raw.selectedAt : null
      }
    } catch {
      return null
    }
  }

  private save(): void {
    const p = this.filePath()
    if (!p) return
    try {
      mkdirSync(join(this.root!, '.claude-manager'), { recursive: true })
      const data: Persisted = {
        version: 1,
        url: this.url,
        label: this.label,
        source: this.source,
        selectedAt: this.selectedAt
      }
      writeFileSync(p, JSON.stringify(data, null, 2))
    } catch {
      // best-effort; the preview still works for this session
    }
  }
}
