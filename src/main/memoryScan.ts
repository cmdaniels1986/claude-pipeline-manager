import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { MemoryBank, MemoryScan } from '../shared/types'
import { userMemoryPaths } from './userMemory'

/**
 * Startup memory check: enumerate every Claude Code auto-memory store on this
 * machine — ALL of which the app now injects into every terminal — so the user
 * can see their full saved memory will be loaded rather than trusting it blind.
 *
 * Stores live at <configDir>/projects/<encoded-path>/memory/MEMORY.md. The one
 * whose encoded path is the home dir is the cross-project ("all projects")
 * store; the rest are per-project stores that a normal `claude` session would
 * only see one-at-a-time. The app injects every store together so a terminal
 * carries the same memory the user has across all their plain Claude sessions.
 */
export function scanMemoryBanks(): MemoryScan {
  const { configDir, encodedHome, dir: activeDir } = userMemoryPaths()
  const projectsDir = join(configDir, 'projects')
  const banks: MemoryBank[] = []

  let entries: string[] = []
  try {
    entries = existsSync(projectsDir) ? readdirSync(projectsDir) : []
  } catch {
    entries = []
  }

  for (const key of entries) {
    const memDir = join(projectsDir, key, 'memory')
    let indexPath = join(memDir, 'MEMORY.md')
    try {
      if (!statSync(memDir).isDirectory()) continue
    } catch {
      continue // not a directory / unreadable
    }
    const bank = readBank(key, memDir, indexPath, key === encodedHome)
    if (bank) banks.push(bank)
  }

  // if the home store folder exists but wasn't enumerated above (edge case),
  // still surface it so "active" is authoritative
  if (!banks.some((b) => b.active) && existsSync(activeDir)) {
    const b = readBank(encodedHome, activeDir, join(activeDir, 'MEMORY.md'), true)
    if (b) banks.push(b)
  }

  banks.sort((a, b) => (a.active === b.active ? b.entries - a.entries : a.active ? -1 : 1))
  const active = banks.find((b) => b.active && b.hasIndex) ?? null
  // Every store found is injected now — not just the home one — so the check is
  // green whenever ANY memory exists on this machine, and reports the total.
  const injectable = banks.filter((b) => b.hasIndex || b.files > 0)

  return {
    configDir,
    banks,
    active,
    ok: injectable.length > 0,
    reason:
      injectable.length > 0
        ? undefined
        : `No Claude memory found under ${projectsDir}. New terminals won't have any saved memory — save a memory from any Claude session, then reopen this app.`
  }
}

/** Build a bank record, or null if the folder has no readable memory index. */
function readBank(key: string, dir: string, indexPath: string, active: boolean): MemoryBank | null {
  let content = ''
  try {
    if (existsSync(indexPath)) content = readFileSync(indexPath, 'utf8')
  } catch {
    content = ''
  }
  const titles = parseTitles(content)
  const files = countMemoryFiles(dir)
  const hasIndex = content.trim().length > 0
  // skip empty folders that are neither the active store nor hold any memory files
  if (!active && !hasIndex && files === 0) return null
  return {
    key,
    dir,
    entries: titles.length,
    files,
    sampleTitles: titles.slice(0, 3),
    active,
    hasIndex
  }
}

/** Titles from a MEMORY.md index: the "- [Title](file.md) — hook" bullet lines. */
function parseTitles(content: string): string[] {
  const titles: string[] = []
  for (const line of content.split('\n')) {
    const m = /^\s*-\s*\[([^\]]+)\]/.exec(line)
    if (m) titles.push(m[1].trim())
  }
  return titles
}

/** Count memory .md files in a store, excluding the MEMORY.md index itself. */
function countMemoryFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && basename(f) !== 'MEMORY.md').length
  } catch {
    return 0
  }
}
