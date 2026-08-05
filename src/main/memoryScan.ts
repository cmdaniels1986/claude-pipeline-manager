import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { MemoryBank, MemoryScan } from '../shared/types'
import { userMemoryPaths } from './userMemory'

/**
 * Startup memory check: enumerate every Claude Code auto-memory store on this
 * machine and confirm the user-level ("all projects") one — the store this app
 * injects into every terminal — is present and readable. This is what makes the
 * otherwise-silent injection visible, so the user can see their memory will be
 * loaded rather than trusting it blind.
 *
 * Stores live at <configDir>/projects/<encoded-path>/memory/MEMORY.md. The one
 * whose encoded path is the home dir is the cross-project store; the rest are
 * per-project stores that would SHADOW it in a normal session (the reason the
 * injection exists), and are reported for context.
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

  return {
    configDir,
    banks,
    active,
    ok: !!active,
    reason: active
      ? undefined
      : existsSync(join(activeDir, 'MEMORY.md'))
        ? `Your cross-project memory index at ${join(activeDir, 'MEMORY.md')} is empty or unreadable.`
        : `No cross-project memory index found at ${join(activeDir, 'MEMORY.md')}. New terminals won't have your saved memory.`
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
