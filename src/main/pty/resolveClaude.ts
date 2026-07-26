import { execFile, execSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export interface ClaudeInfo {
  exePath: string
  version: string
  hasAppendSystemPromptFile: boolean
}

function candidatePaths(): string[] {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return [
    // npm global install — preferred (checked first so a stale native-installer
    // copy elsewhere can't shadow it)
    join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    // native installer (irm https://claude.ai/install.ps1)
    join(homedir(), '.local', 'bin', 'claude.exe')
  ]
}

export function resolveClaudeExe(): string {
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p
  }

  // PATH fallback: `where` may return a real exe or an npm shim (.cmd/.ps1);
  // for shims, resolve the actual binary sitting behind them
  try {
    const lines = execSync('where claude', { encoding: 'utf8', timeout: 10000 })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    for (const line of lines) {
      const lower = line.toLowerCase()
      if (lower.endsWith('.exe') && existsSync(line)) return line
      if (lower.endsWith('.cmd') || lower.endsWith('.ps1')) {
        const behindShim = join(
          dirname(line),
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'bin',
          'claude.exe'
        )
        if (existsSync(behindShim)) return behindShim
      }
    }
  } catch {
    // where not available or no match — fall through to the error below
  }

  throw new Error(
    'Claude Code CLI not found on this machine.\n\n' +
      'Install it with:  npm install -g @anthropic-ai/claude-code\n' +
      'then run "claude" once in a terminal to log in, and start this app again.\n\n' +
      'Locations checked: npm global install, ~\\.local\\bin, and PATH.'
  )
}

export interface LoginResult {
  ok: boolean
  detail: string
}

/** Probes auth by asking the CLI to answer a trivial prompt in print mode.
 *  A logged-in CLI replies; otherwise it errors (auth / login / unknown flag). */
export async function checkLogin(exePath: string): Promise<LoginResult> {
  try {
    const { stdout } = await execFileP(exePath, ['-p', 'Reply with the single word: ready'], {
      timeout: 60000,
      maxBuffer: 1024 * 1024
    })
    const out = stdout.trim()
    if (/ready/i.test(out)) return { ok: true, detail: 'Logged in — Claude responded.' }
    return { ok: true, detail: out ? `Responded: ${out.slice(0, 200)}` : 'Responded (empty output).' }
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = (e.stderr || e.stdout || e.message || String(err)).toString().trim().slice(0, 600)
    return { ok: false, detail: detail || 'Claude exited with an error and no output.' }
  }
}

export async function detectClaude(): Promise<ClaudeInfo> {
  const exePath = resolveClaudeExe()
  const [versionOut, helpOut] = await Promise.all([
    execFileP(exePath, ['--version'], { timeout: 15000 }).then(
      (r) => r.stdout.trim(),
      () => 'unknown'
    ),
    execFileP(exePath, ['--help'], { timeout: 15000, maxBuffer: 1024 * 1024 }).then(
      (r) => r.stdout + r.stderr,
      () => ''
    )
  ])
  return {
    exePath,
    version: versionOut,
    hasAppendSystemPromptFile: helpOut.includes('--append-system-prompt-file')
  }
}
