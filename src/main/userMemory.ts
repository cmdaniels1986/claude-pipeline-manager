import { existsSync, readFileSync } from 'fs'
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

/**
 * Formats the user-level memory index as a system-prompt section, mirroring how
 * a normal session surfaces auto-memory: the index is background context, and
 * each bullet points to a file in the memory dir the model can read on demand.
 * Returns '' when there is no user memory to inject.
 */
export function buildUserMemoryBlock(): string {
  const mem = resolveUserMemory()
  if (!mem) return ''
  return [
    '# Your saved memory (user-level — all projects)',
    `This is your persistent cross-project memory index, loaded so this terminal has the`,
    `same context you get when opening Claude normally — regardless of which folder is open.`,
    `Each bullet points to a file in \`${mem.dir}\` that you can Read on demand for full detail.`,
    `Treat it as background context that was true when written; verify specifics before relying on them.`,
    '',
    mem.content
  ].join('\n')
}
