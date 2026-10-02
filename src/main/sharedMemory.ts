import { watch, type FSWatcher } from 'chokidar'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import matter from 'gray-matter'
import { basename, dirname, join, resolve } from 'path'
import type {
  LinkedMemoryInfo,
  MemoryImportResult,
  MemorySettings,
  SharedMemoryEntry,
  SharedMemoryState
} from '../shared/types'
import { listMemoryBanks } from './userMemory'

const INDEX_FILE = 'MEMORY.md'
/** an index line: "- [Title](file.md) — hook" */
const ENTRY_RE = /^\s*-\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[—–-]+\s*(.*))?$/
/** a single linked memory file is injected whole, up to this many characters */
const MAX_LINKED_FILE_CHARS = 6000
const CHANGE_DEBOUNCE_MS = 150

const DEFAULT_INDEX_HEADER = [
  '# Global Memory',
  '',
  'Shared memory for everyone working on these projects. Each line points to one memory file in this folder.',
  'Maintained by Claude Pipeline Manager: choose this folder as your Global Memory (🧠 Memory panel) to load it',
  'into your Claude terminals and save to it.',
  ''
]

type Data = Record<string, unknown>

const isRecord = (v: unknown): v is Data => typeof v === 'object' && v !== null && !Array.isArray(v)

/** a trimmed non-empty string, or undefined (YAML turns bare dates into Date objects) */
function str(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString()
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** drop undefined values — the YAML dumper refuses them */
function compact(o: Data): Data {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** kebab-case file-safe slug; also the guard against path tricks in a name */
export function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return s || 'memory'
}

const humanize = (slug: string): string => {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : slug
}

/** MEMORY.md and the conflict copies cloud sync makes of it ("MEMORY (1).md",
 *  "MEMORY-DESKTOP.md"). Memory files themselves are lowercase slugs. */
function isIndexFile(file: string): boolean {
  return file.startsWith('MEMORY') || file.toLowerCase() === 'memory.md'
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** temp-file + rename so a synced folder never sees a half-written file */
function writeText(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    writeFileSync(path, content)
  }
}

function parseMemory(text: string): { data: Data; body: string } {
  try {
    // passing an options object bypasses gray-matter's content-keyed cache
    const parsed = matter(text, {})
    return { data: isRecord(parsed.data) ? parsed.data : {}, body: parsed.content }
  } catch {
    return { data: {}, body: text } // malformed frontmatter — treat it all as body
  }
}

/** "- [Title](file.md) — hook" lines of a MEMORY.md, keyed by file name */
function parseIndexLines(content: string): Map<string, { title: string; hook: string }> {
  const map = new Map<string, { title: string; hook: string }>()
  for (const line of content.split(/\r?\n/)) {
    const m = ENTRY_RE.exec(line)
    if (m) map.set(basename(m[2].trim()), { title: m[1].trim(), hook: (m[3] ?? '').trim() })
  }
  return map
}

function firstHeading(body: string): string | undefined {
  return /^#{1,6}\s+(.+)$/m.exec(body)?.[1].trim() || undefined
}

function firstLine(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*-]+/, '').trim()
    if (line && !line.startsWith('#') && line !== '---') return line.length > 160 ? line.slice(0, 157) + '…' : line
  }
  return ''
}

function entryFrom(file: string, data: Data, body: string, idx?: { title: string; hook: string }): SharedMemoryEntry {
  const meta = isRecord(data.metadata) ? data.metadata : {}
  const name = file.replace(/\.md$/i, '')
  return {
    name,
    file,
    title: str(meta.title) ?? idx?.title ?? firstHeading(body) ?? humanize(name),
    description: str(data.description) ?? (idx?.hook || firstLine(body)),
    type: str(meta.type) ?? str(data.type),
    author: str(meta.author),
    updated: str(meta.updated)
  }
}

/** Every memory file in a folder (not the index), read from its frontmatter, with
 *  titles/hooks from the folder's MEMORY.md where the file itself lacks them. */
export function listMemoryEntries(dir: string): SharedMemoryEntry[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && !isIndexFile(f))
  } catch {
    return []
  }
  const idx = parseIndexLines(readText(join(dir, INDEX_FILE)))
  return files.sort().map((file) => {
    const { data, body } = parseMemory(readText(join(dir, file)))
    return entryFrom(file, data, body, idx.get(file))
  })
}

const indexLine = (e: SharedMemoryEntry): string =>
  `- [${oneLine(e.title).replace(/[[\]]/g, '')}](${e.file})${e.description ? ` — ${oneLine(e.description)}` : ''}`

/**
 * Rebuild a MEMORY.md from the files actually in the folder. Everything that isn't
 * an entry line (the header, notes people added) stays where it is; entry lines are
 * regenerated in place, lines for deleted files are dropped, and files the index
 * doesn't mention yet are appended. Deriving the index from the files means two
 * people saving through a synced folder can't leave it pointing at the wrong set.
 */
export function renderIndex(existing: string, entries: SharedMemoryEntry[]): string {
  const byFile = new Map(entries.map((e) => [e.file, e]))
  const placed = new Set<string>()
  const lines: string[] = []
  const source = existing.trim() ? existing.replace(/\r\n/g, '\n').split('\n') : DEFAULT_INDEX_HEADER
  for (const line of source) {
    const m = ENTRY_RE.exec(line)
    if (!m) {
      lines.push(line)
      continue
    }
    const e = byFile.get(basename(m[2].trim()))
    if (!e || placed.has(e.file)) continue // dangling or duplicate line
    lines.push(indexLine(e))
    placed.add(e.file)
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const fresh = entries.filter((e) => !placed.has(e.file))
  if (fresh.length) {
    if (lines.length && !ENTRY_RE.test(lines[lines.length - 1])) lines.push('')
    lines.push(...fresh.map(indexLine))
  }
  return lines.join('\n') + '\n'
}

/** Re-derive the folder's MEMORY.md; only writes when it actually changes, so
 *  opening the folder doesn't churn a cloud sync. */
export function refreshIndex(dir: string): void {
  const path = join(dir, INDEX_FILE)
  const existing = readText(path)
  const next = renderIndex(existing, listMemoryEntries(dir))
  if (next !== existing) writeText(path, next)
}

export interface SaveMemoryInput {
  /** kebab-case slug (file name); derived from the title when omitted */
  name?: string
  title: string
  description: string
  type?: string
  body: string
}

/** Write one memory file (same name = update) in Claude Code's memory format,
 *  stamped with who saved it, then refresh the folder's index. */
export function saveMemory(
  dir: string,
  input: SaveMemoryInput,
  author: string
): { name: string; path: string; updated: boolean } {
  mkdirSync(dir, { recursive: true })
  const name = slugify(input.name?.trim() || input.title)
  const path = join(dir, `${name}.md`)
  const updated = existsSync(path)
  const prev = updated ? parseMemory(readText(path)).data : {}
  const prevMeta = isRecord(prev.metadata) ? prev.metadata : {}
  const data = compact({
    ...prev,
    name,
    description: oneLine(input.description),
    metadata: compact({
      ...prevMeta,
      type: str(input.type) ?? str(prevMeta.type),
      title: oneLine(input.title),
      author,
      updated: new Date().toISOString()
    })
  })
  writeText(path, matter.stringify(`\n${input.body.trim()}\n`, data))
  refreshIndex(dir)
  return { name, path, updated }
}

export function removeMemory(dir: string, name: string): boolean {
  const path = join(dir, `${slugify(name)}.md`)
  if (!existsSync(path)) return false
  unlinkSync(path)
  refreshIndex(dir)
  return true
}

/** Copy memory files the user picked (e.g. from their own memory stores) into a
 *  memory folder, keeping their content and filling in the title/hook from the
 *  source folder's MEMORY.md so they read the same in the shared index. */
export function importMemoryFiles(dir: string, paths: string[], author: string): MemoryImportResult {
  const result: MemoryImportResult = { added: [], updated: [], skipped: [] }
  mkdirSync(dir, { recursive: true })
  const indexes = new Map<string, Map<string, { title: string; hook: string }>>()
  const now = new Date().toISOString()
  for (const src of paths) {
    const file = basename(src)
    if (isIndexFile(file)) {
      result.skipped.push({
        file,
        reason: 'that is an index, not a memory — pick the memory files it lists, or use Link to load the whole folder'
      })
      continue
    }
    if (samePath(dirname(src), dir)) {
      result.skipped.push({ file, reason: 'already in Global Memory' })
      continue
    }
    const text = readText(src)
    if (!text.trim()) {
      result.skipped.push({ file, reason: 'empty or unreadable' })
      continue
    }
    const srcDir = dirname(src)
    let idx = indexes.get(srcDir)
    if (!idx) {
      idx = parseIndexLines(readText(join(srcDir, INDEX_FILE)))
      indexes.set(srcDir, idx)
    }
    const { data, body } = parseMemory(text)
    const e = entryFrom(file, data, body, idx.get(file))
    const meta = isRecord(data.metadata) ? data.metadata : {}
    const name = slugify(str(data.name) ?? file)
    const target = join(dir, `${name}.md`)
    const existed = existsSync(target)
    const out = compact({
      ...data,
      name,
      description: e.description || undefined,
      metadata: compact({ ...meta, type: e.type, title: e.title, author: str(meta.author) ?? author, updated: now })
    })
    writeText(target, matter.stringify(body, out))
    ;(existed ? result.updated : result.added).push(name)
  }
  if (result.added.length || result.updated.length) refreshIndex(dir)
  return result
}

/** What a linked path is: a memory folder, a folder's MEMORY.md, or one memory file. */
function classify(path: string): { kind: LinkedMemoryInfo['kind']; dir: string; exists: boolean } {
  const isIndex = /^memory\.md$/i.test(basename(path))
  try {
    if (statSync(path).isDirectory()) return { kind: 'folder', dir: path, exists: true }
    return { kind: isIndex ? 'index' : 'file', dir: dirname(path), exists: true }
  } catch {
    // unreachable right now (drive unplugged, sync app not running) — guess from the name
    const kind = isIndex ? 'index' : /\.(md|txt)$/i.test(path) ? 'file' : 'folder'
    return { kind, dir: kind === 'folder' ? path : dirname(path), exists: false }
  }
}

/** Titles listed by a memory folder — from its MEMORY.md, else from its files. */
function folderTitles(dir: string): string[] {
  const index = readText(join(dir, INDEX_FILE))
  if (index.trim()) return [...parseIndexLines(index).values()].map((v) => v.title)
  return listMemoryEntries(dir).map((e) => e.title)
}

export function describeLinked(
  src: { id: string; path: string; addedAt: string },
  machineDirs: string[],
  globalDir: string | null
): LinkedMemoryInfo {
  const c = classify(src.path)
  let duplicateOf: LinkedMemoryInfo['duplicateOf']
  if (c.kind !== 'file') {
    if (globalDir && samePath(c.dir, globalDir)) duplicateOf = 'global'
    else if (machineDirs.some((d) => samePath(d, c.dir))) duplicateOf = 'machine'
  }
  let titles: string[] = []
  if (c.exists) {
    if (c.kind === 'file') {
      const { data, body } = parseMemory(readText(src.path))
      titles = [entryFrom(basename(src.path), data, body).title]
    } else {
      titles = folderTitles(c.dir)
    }
  }
  return {
    ...src,
    kind: c.kind,
    exists: c.exists,
    entries: titles.length,
    sampleTitles: titles.slice(0, 3),
    ...(duplicateOf ? { duplicateOf } : {})
  }
}

/**
 * The system-prompt section for Global Memory and linked memory. Always present
 * (even before a location is chosen) so a terminal knows what "save this to global
 * memory" means and routes it to the global_memory_save tool.
 */
export function buildSharedMemoryBlock(settings: MemorySettings, machineDirs: string[]): string {
  const parts: string[] = []
  const g = settings.globalDir
  if (g) {
    const reachable = existsSync(g)
    const entries = reachable ? listMemoryEntries(g) : []
    parts.push(
      [
        '# Global memory (shared with others on these projects)',
        `The user keeps a Global Memory: a shared folder of memory files that other people working on these projects also load into their Claude sessions. Folder: ${g}${reachable ? '' : ' (unreachable right now — is the drive or sync app running?)'}`,
        '- When the user asks to save something to "global memory" (or shared/team memory, or "so others know"), call the graph MCP server\'s global_memory_save tool instead of writing your personal memory. Write it for a reader who lacks this conversation: the fact, why it matters, how to apply it. Never put secrets, credentials or private personal details there.',
        '- An ordinary "remember this" still goes to your personal memory. global_memory_list shows the current entries (others may have added some since this session started); global_memory_remove deletes one when asked or when it is proven wrong.',
        '- Each line below points to a file in that folder; Read it for full detail. Treat it as background context that was true when written.',
        '',
        entries.length ? entries.map(indexLine).join('\n') : '(empty — nothing saved yet)'
      ].join('\n')
    )
  } else {
    parts.push(
      [
        '# Global memory (shared)',
        'The user can keep a Global Memory — a shared folder of memories that other people working on these projects also load — but has not chosen its location yet. If they ask you to save something to global or shared memory, call the graph MCP server\'s global_memory_save tool anyway; it will tell them to pick a folder in the Pipeline Manager (🧠 Memory → Global Memory → Choose location…).'
      ].join('\n')
    )
  }

  const linked = settings.linked
    .map((l) => describeLinked(l, machineDirs, g))
    .filter((l) => l.exists && !l.duplicateOf)
  if (linked.length) {
    const sections = linked.map((l) => {
      if (l.kind === 'file') {
        const text = readText(l.path).trim()
        const body =
          text.length > MAX_LINKED_FILE_CHARS
            ? `${text.slice(0, MAX_LINKED_FILE_CHARS)}\n\n(truncated — Read ${l.path} for the rest)`
            : text
        return [`## Memory file — ${l.path}`, '', body].join('\n')
      }
      const dir = l.kind === 'index' ? dirname(l.path) : l.path
      const index = readText(join(dir, INDEX_FILE)).trim()
      const body = index || listMemoryEntries(dir).map(indexLine).join('\n')
      return [`## Memory folder — ${dir}`, '', body].join('\n')
    })
    parts.push(
      [
        '# Linked memory (added by the user from other locations, read-only)',
        'Memory the user linked from elsewhere, such as a teammate\'s shared memory. Bullets point to files in the listed folder that you can Read on demand. Do not write to these locations.',
        '',
        sections.join('\n\n')
      ].join('\n')
    )
  }
  return parts.join('\n\n')
}

/**
 * The user's Global Memory location and linked memory sources (app-wide, saved in
 * <userData>/memory-sources.json), plus the operations the UI and the MCP tools
 * run on them. Watches the Global Memory folder so a teammate's save, synced in,
 * shows up live.
 */
export class MemorySources {
  private settingsPath: string
  private data: MemorySettings
  private watcher: FSWatcher | null = null
  private changeTimer: NodeJS.Timeout | null = null

  constructor(
    private opts: { userDataDir: string; author: string; onChange?: (state: SharedMemoryState) => void }
  ) {
    this.settingsPath = join(opts.userDataDir, 'memory-sources.json')
    this.data = this.load()
    this.watchGlobal()
  }

  settings(): MemorySettings {
    return this.data
  }

  globalDir(): string | null {
    return this.data.globalDir
  }

  state(): SharedMemoryState {
    const g = this.data.globalDir
    const machineDirs = machineMemoryDirs()
    return {
      global: g ? { dir: g, exists: existsSync(g), entries: listMemoryEntries(g) } : null,
      linked: this.data.linked.map((l) => describeLinked(l, machineDirs, g))
    }
  }

  promptBlock(): string {
    return buildSharedMemoryBlock(this.data, machineMemoryDirs())
  }

  /** Point Global Memory at a folder (created + given an index if new), or null to stop. */
  setGlobalDir(dir: string | null): SharedMemoryState {
    if (dir) {
      mkdirSync(dir, { recursive: true })
      refreshIndex(dir)
    }
    this.data.globalDir = dir || null
    this.persist()
    this.watchGlobal()
    this.emitChange()
    return this.state()
  }

  link(path: string): SharedMemoryState {
    if (!this.data.linked.some((l) => samePath(l.path, path))) {
      this.data.linked.push({ id: `m-${randomUUID().slice(0, 8)}`, path, addedAt: new Date().toISOString() })
      this.persist()
      this.emitChange()
    }
    return this.state()
  }

  unlink(id: string): SharedMemoryState {
    const before = this.data.linked.length
    this.data.linked = this.data.linked.filter((l) => l.id !== id)
    if (this.data.linked.length !== before) {
      this.persist()
      this.emitChange()
    }
    return this.state()
  }

  save(input: SaveMemoryInput): { ok: true; name: string; path: string; updated: boolean } | { ok: false; error: string } {
    const dir = this.data.globalDir
    if (!dir) {
      return {
        ok: false,
        error:
          'No Global Memory location is set. Ask the user to choose one in Claude Pipeline Manager: 🧠 Memory → Global Memory → Choose location… (a shared or synced folder such as Google Drive, OneDrive or Dropbox).'
      }
    }
    try {
      const r = saveMemory(dir, input, this.opts.author)
      this.emitChange()
      return { ok: true, ...r }
    } catch (err) {
      return { ok: false, error: `Could not write to ${dir}: ${String(err)}` }
    }
  }

  remove(name: string): { ok: boolean; error?: string } {
    const dir = this.data.globalDir
    if (!dir) return { ok: false, error: 'No Global Memory location is set.' }
    try {
      const removed = removeMemory(dir, name)
      if (removed) this.emitChange()
      return removed ? { ok: true } : { ok: false, error: `No global memory named "${slugify(name)}".` }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  importFiles(paths: string[]): MemoryImportResult {
    const dir = this.data.globalDir
    if (!dir) return { added: [], updated: [], skipped: paths.map((p) => ({ file: basename(p), reason: 'no Global Memory location set' })) }
    const r = importMemoryFiles(dir, paths, this.opts.author)
    if (r.added.length || r.updated.length) this.emitChange()
    return r
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer)
    void this.watcher?.close()
    this.watcher = null
  }

  private emitChange(): void {
    if (!this.opts.onChange) return
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => this.opts.onChange?.(this.state()), CHANGE_DEBOUNCE_MS)
  }

  private watchGlobal(): void {
    void this.watcher?.close()
    this.watcher = null
    const dir = this.data.globalDir
    if (!dir || !existsSync(dir)) return
    try {
      this.watcher = watch(dir, {
        ignoreInitial: true,
        depth: 0,
        ignored: (p: string) => p.endsWith('.tmp'),
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
      })
      this.watcher.on('all', () => this.emitChange())
      this.watcher.on('error', () => {}) // a flaky network/sync drive shouldn't crash the app
    } catch {
      this.watcher = null
    }
  }

  private load(): MemorySettings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      if (raw && raw.version === 1) {
        return {
          version: 1,
          globalDir: typeof raw.globalDir === 'string' && raw.globalDir.trim() ? raw.globalDir : null,
          linked: Array.isArray(raw.linked)
            ? raw.linked.filter((l: unknown) => isRecord(l) && typeof l.path === 'string' && typeof l.id === 'string')
            : []
        }
      }
    } catch {
      // first run or unreadable — start empty
    }
    return { version: 1, globalDir: null, linked: [] }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.settingsPath), { recursive: true })
      writeText(this.settingsPath, JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.error('Failed to save memory-sources.json:', err)
    }
  }
}

function machineMemoryDirs(): string[] {
  return listMemoryBanks().map((b) => b.dir)
}
