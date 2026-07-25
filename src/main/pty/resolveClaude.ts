import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
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
    // Real binary behind the npm shim — preferred (avoids stale copies elsewhere on PATH)
    join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  ]
}

export function resolveClaudeExe(): string {
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p
  }
  throw new Error(
    'Claude Code CLI not found. Expected the npm global install at %APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  )
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
