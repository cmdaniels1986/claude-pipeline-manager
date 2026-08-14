import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// A stable, discoverable, space-free location so the injected path never needs
// awkward quoting on the Claude Code input line.
const DIR = join(homedir(), '.claude', 'pasted-images')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg'
}

// filesystem-safe timestamp, e.g. 2026-08-09T14-03-22-517Z
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Writes pasted image bytes to ~/.claude/pasted-images and returns the file.
 * The caller injects the returned path into the PTY so Claude Code reads it as an
 * attachment — exactly what its own drag-and-drop does.
 */
export function savePastedImage(bytes: Uint8Array, mime: string): { path: string; fileName: string } {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  const ext = EXT_BY_MIME[mime.toLowerCase()] ?? 'png'
  const fileName = `paste-${stamp()}.${ext}`
  const path = join(DIR, fileName)
  writeFileSync(path, Buffer.from(bytes))
  return { path, fileName }
}

/** Best-effort removal of pasted images older than a week so the dir can't grow forever. */
export function prunePastedImages(): void {
  try {
    if (!existsSync(DIR)) return
    const now = Date.now()
    for (const name of readdirSync(DIR)) {
      const p = join(DIR, name)
      try {
        if (now - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p)
      } catch {
        // file vanished or momentarily locked — skip it
      }
    }
  } catch {
    // dir unreadable — nothing to prune
  }
}
