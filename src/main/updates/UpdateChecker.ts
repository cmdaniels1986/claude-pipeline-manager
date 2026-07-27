import { execFile, spawn } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { UpdateCheckResult, UpdateStatus } from '../../shared/types'

const execFileP = promisify(execFile)

function firstLine(s: string): string {
  return (s || '').split('\n')[0].trim().slice(0, 200)
}

/** Marker file the launcher .bat watches: if present after the app exits, it
 *  deletes it and boots the app again (completing an update restart). */
export const RESTART_MARKER = '.update-restart'

export function isGitInstall(root: string): boolean {
  return existsSync(join(root, '.git'))
}

/** Detailed check: fetches origin, reports how far behind origin/main, and — on
 *  failure — WHY (so a manual check can tell the user git is missing / GitHub is
 *  unreachable rather than failing silently). */
export async function checkForUpdatesDetailed(root: string): Promise<UpdateCheckResult> {
  if (!isGitInstall(root)) {
    return { ok: false, reason: 'This copy is not a git clone, so it can’t self-update. Re-clone from GitHub to enable updates.' }
  }
  try {
    await execFileP('git', ['fetch', '--quiet', 'origin'], { cwd: root, timeout: 25000 })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    if (/not recognized|ENOENT|not found/i.test(m)) {
      return { ok: false, reason: 'git wasn’t found on this app’s PATH. Install Git (or launch the app from a terminal where `git` works).' }
    }
    return { ok: false, reason: 'Couldn’t reach GitHub — offline, or a proxy/firewall is blocking it. ' + firstLine(m) }
  }
  try {
    const { stdout: behindStr } = await execFileP('git', ['rev-list', '--count', 'HEAD..origin/main'], {
      cwd: root,
      timeout: 10000
    })
    const behind = parseInt(behindStr.trim(), 10) || 0
    if (!behind) return { ok: true, behind: 0, latest: '' }
    const { stdout: msg } = await execFileP('git', ['log', '-1', '--format=%s', 'origin/main'], {
      cwd: root,
      timeout: 10000
    })
    return { ok: true, behind, latest: msg.trim() }
  } catch (err) {
    return { ok: false, reason: firstLine(err instanceof Error ? err.message : String(err)) }
  }
}

/** Background check used for the auto-banner; null unless there's an update. */
export async function checkForUpdates(root: string): Promise<UpdateStatus | null> {
  const r = await checkForUpdatesDetailed(root)
  return r.ok && r.behind ? { behind: r.behind, latest: r.latest ?? '' } : null
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
