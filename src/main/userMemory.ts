import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Claude Code's config dir (honors CLAUDE_CONFIG_DIR), where per-project stores live. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

/** Claude Code encodes a project path into a folder name by replacing each path
 *  separator and the drive colon with a dash: C:\Users\cmdan -> C--Users-cmdan. */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[\\/:]/g, '-')
}

/** Where the user-level ("all projects") memory store lives — the single source
 *  of truth for both the injector and the startup memory check. */
export function userMemoryPaths(): { configDir: string; encodedHome: string; dir: string; indexPath: string } {
  const configDir = claudeConfigDir()
  const encodedHome = encodeProjectPath(homedir())
  const dir = join(configDir, 'projects', encodedHome, 'memory')
  return { configDir, encodedHome, dir, indexPath: join(dir, 'MEMORY.md') }
}

/**
 * Locates the user's "home"/user-level auto-memory index — the cross-project
 * MEMORY.md that a normal `claude` session picks up when launched from the home
 * directory. Claude Code resolves auto-memory by walking up from the working
 * folder to the nearest scope that has a memory store, so terminals opened in a
 * folder that has its OWN memory (or lives off the home drive) never see this
 * cross-project index. We read it here so the app can inject it into every
 * session and reproduce the "opened Claude normally" experience.
 */
export function resolveUserMemory(): { dir: string; indexPath: string; content: string } | null {
  try {
    const { dir, indexPath } = userMemoryPaths()
    if (!existsSync(indexPath)) return null
    const content = readFileSync(indexPath, 'utf8').trim()
    if (!content) return null
    return { dir, indexPath, content }
  } catch {
    // Missing/unreadable memory is fine — we just don't inject anything.
    return null
  }
}

/** One discovered auto-memory store, with its index content ready to inject. */
export interface MemoryBankContent {
  /** the encoded project-path folder name (e.g. C--Users-cmdan) */
  key: string
  /** absolute path to the store's memory/ folder */
  dir: string
  /** absolute path to its MEMORY.md index */
  indexPath: string
  /** trimmed MEMORY.md content ('' when the store has no readable index) */
  content: string
  /** memory .md filenames besides MEMORY.md, so index-less stores are still discoverable */
  files: string[]
  /** true for the cross-project ("all projects") store keyed to the home dir */
  isHome: boolean
}

/**
 * Enumerate EVERY Claude Code auto-memory store on this machine, not just the
 * home one. Claude keeps a separate memory store per project scope
 * (<configDir>/projects/<encoded-path>/memory), and a normal `claude` session
 * only ever sees the one nearest its cwd. To give app terminals the same memory
 * a person has across ALL their plain Claude sessions, we gather every store and
 * inject them together. Ordered home-first, then by size, so the most general
 * context leads. Empty stores (no index and no files) are skipped.
 */
export function listMemoryBanks(): MemoryBankContent[] {
  const { configDir, encodedHome } = userMemoryPaths()
  const projectsDir = join(configDir, 'projects')
  const banks: MemoryBankContent[] = []

  let entries: string[] = []
  try {
    entries = existsSync(projectsDir) ? readdirSync(projectsDir) : []
  } catch {
    entries = []
  }

  for (const key of entries) {
    const dir = join(projectsDir, key, 'memory')
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue // not a directory / unreadable
    }
    const indexPath = join(dir, 'MEMORY.md')
    let content = ''
    try {
      if (existsSync(indexPath)) content = readFileSync(indexPath, 'utf8').trim()
    } catch {
      content = ''
    }
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    } catch {
      files = []
    }
    if (!content && files.length === 0) continue // truly empty store
    banks.push({ key, dir, indexPath, content, files, isHome: key === encodedHome })
  }

  banks.sort((a, b) =>
    a.isHome !== b.isHome
      ? a.isHome
        ? -1
        : 1
      : b.files.length - a.files.length || a.key.localeCompare(b.key)
  )
  return banks
}

/**
 * Formats EVERY memory store on the machine as a system-prompt section, so an app
 * terminal carries the same memory the user has across all their plain Claude
 * sessions — regardless of which folder is open or which machine/username this is.
 * Each store becomes its own section: the index is background context, and each
 * bullet points to a file in that store's folder the model can Read on demand.
 * Returns '' when no memory stores exist.
 */
export function buildUserMemoryBlock(): string {
  const banks = listMemoryBanks()
  if (banks.length === 0) return ''

  const header = [
    '# Your saved memory (every Claude memory store on this machine)',
    'Below is every Claude Code auto-memory store found on this computer, injected so this',
    'terminal carries the same saved context you have across ALL your plain Claude sessions —',
    'no matter which folder is open. Each section is one store; its bullets point to files in',
    'the listed folder that you can Read on demand for full detail. Treat it as background',
    'context that was true when written; verify specifics before relying on them.'
  ].join('\n')

  const sections = banks.map((b) => {
    const title = b.isHome
      ? `## Cross-project memory (all projects) — ${b.dir}`
      : `## Project memory: ${b.key} — ${b.dir}`
    const body = b.content
      ? b.content
      : `(No MEMORY.md index; memory files present — Read directly: ${b.files.join(', ')})`
    return [title, '', body].join('\n')
  })

  return [header, ...sections].join('\n\n')
}
