import { execFile, spawn } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { UpdateStatus } from '../../shared/types'

const execFileP = promisify(execFile)

/** Marker file the launcher .bat watches: if present after the app exits, it
 *  deletes it and boots the app again (completing an update restart). */
export const RESTART_MARKER = '.update-restart'

export function isGitInstall(root: string): boolean {
  return existsSync(join(root, '.git'))
}

/** Fetches origin and reports how far behind origin/main this copy is.
 *  Returns null when the check can't run (no git, offline, no remote). */
export async function checkForUpdates(root: string): Promise<UpdateStatus | null> {
  try {
    await execFileP('git', ['fetch', '--quiet', 'origin'], { cwd: root, timeout: 25000 })
    const { stdout: behindStr } = await execFileP(
      'git',
      ['rev-list', '--count', 'HEAD..origin/main'],
      { cwd: root, timeout: 10000 }
    )
    const behind = parseInt(behindStr.trim(), 10) || 0
    if (!behind) return { behind: 0, latest: '' }
    const { stdout: msg } = await execFileP('git', ['log', '-1', '--format=%s', 'origin/main'], {
      cwd: root,
      timeout: 10000
    })
    return { behind, latest: msg.trim() }
  } catch {
    return null
  }
}

/** Pulls origin/main and reinstalls dependencies. On success writes the restart
 *  marker; the caller is expected to exit the app shortly after. */
export async function applyUpdate(root: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileP('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: root, timeout: 120000 })
  } catch (err) {
    return {
      ok: false,
      error:
        'git pull failed — you may have local changes in the app folder. ' +
        (err instanceof Error ? err.message.split('\n')[0] : String(err))
    }
  }

  const installOk = await new Promise<boolean>((resolve) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: root,
      shell: true,
      stdio: 'ignore'
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
  if (!installOk) {
    return { ok: false, error: 'Update pulled, but npm install failed — run it manually, then restart.' }
  }

  writeFileSync(join(root, RESTART_MARKER), '')
  return { ok: true }
}
