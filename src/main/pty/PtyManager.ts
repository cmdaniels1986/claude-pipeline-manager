import { spawn, type IPty } from '@lydell/node-pty'
import { randomUUID } from 'crypto'
import type { CreateTermOptions, TermInfo } from '../../shared/types'
import { buildLaunchArgs } from './launchArgs'

interface TermRec {
  termId: string
  pty: IPty
  cwd: string
  agentName?: string
  color?: string
  alive: boolean
  /** original launch options, kept so the session can be relaunched with --resume */
  opts: CreateTermOptions
}

export interface PtyManagerDeps {
  claudeExePath: string
  hasAppendSystemPromptFile: boolean
  protocolPath: string
  settingsFallbackPath: string
  /** writes the per-terminal mcp-config file and returns its path */
  writeMcpConfig: (termId: string) => string
  /** extra env for each spawned session (OTEL telemetry pointing at the usage receiver) */
  usageEnv: () => Record<string, string>
  onData: (termId: string, data: string) => void
  onExit: (termId: string, exitCode: number) => void
}

export class PtyManager {
  private terms = new Map<string, TermRec>()

  constructor(private deps: PtyManagerDeps) {}

  create(opts: CreateTermOptions): TermInfo {
    const termId = randomUUID()
    const rec: TermRec = {
      termId,
      pty: this.spawnClaude(termId, opts, false),
      cwd: opts.cwd,
      agentName: opts.agentName,
      color: opts.color,
      alive: true,
      opts
    }
    this.terms.set(termId, rec)
    this.wire(rec)
    return this.toInfo(rec)
  }

  /** Relaunches an ended session with --resume so its conversation continues under
   *  the same termId (used to bring a session back after a usage-limit reset). No-op
   *  if the session is still alive. Returns false if the terminal is unknown. */
  relaunchResume(termId: string): boolean {
    const rec = this.terms.get(termId)
    if (!rec) return false
    if (rec.alive) return true
    rec.pty = this.spawnClaude(termId, rec.opts, true)
    rec.alive = true
    this.wire(rec)
    return true
  }

  isAlive(termId: string): boolean {
    return this.terms.get(termId)?.alive ?? false
  }

  private spawnClaude(termId: string, opts: CreateTermOptions, resume: boolean): IPty {
    const mcpConfigPath = this.deps.writeMcpConfig(termId)
    const args = buildLaunchArgs({
      sessionId: termId,
      agentName: opts.agentName,
      model: opts.model,
      dangerous: opts.dangerous,
      mcpConfigPath,
      protocolPath: this.deps.protocolPath,
      settingsFallbackPath: this.deps.settingsFallbackPath,
      hasAppendSystemPromptFile: this.deps.hasAppendSystemPromptFile,
      resume
    })
    return spawn(this.deps.claudeExePath, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      useConpty: true,
      env: {
        ...(process.env as Record<string, string>),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...this.deps.usageEnv()
      }
    })
  }

  private wire(rec: TermRec): void {
    rec.pty.onData((data) => this.deps.onData(rec.termId, data))
    rec.pty.onExit(({ exitCode }) => {
      rec.alive = false
      this.deps.onExit(rec.termId, exitCode)
    })
  }

  write(termId: string, data: string): void {
    const rec = this.terms.get(termId)
    if (rec?.alive) rec.pty.write(data)
  }

  resize(termId: string, cols: number, rows: number): void {
    const rec = this.terms.get(termId)
    if (!rec?.alive) return
    if (cols > 0 && rows > 0) rec.pty.resize(cols, rows)
  }

  /** Types text into the session inside a bracketed paste so embedded newlines
   *  don't submit early; optionally presses Enter shortly after. */
  injectPrompt(termId: string, text: string, autoSubmit: boolean): void {
    const rec = this.terms.get(termId)
    if (!rec?.alive) throw new Error('Terminal is not running')
    rec.pty.write(`\x1b[200~${text}\x1b[201~`)
    if (autoSubmit) {
      // generous delay: if Enter lands while the TUI is mid-redraw the text stays
      // queued in the input box instead of submitting
      setTimeout(() => {
        if (rec.alive) rec.pty.write('\r')
      }, 400)
    }
  }

  dispose(termId: string): void {
    const rec = this.terms.get(termId)
    if (rec) {
      if (rec.alive) rec.pty.kill()
      this.terms.delete(termId)
    }
  }

  disposeAll(): void {
    for (const rec of this.terms.values()) {
      if (rec.alive) rec.pty.kill()
    }
    this.terms.clear()
  }

  list(): TermInfo[] {
    return [...this.terms.values()].map((r) => this.toInfo(r))
  }

  private toInfo(rec: TermRec): TermInfo {
    const cwdBase = rec.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? rec.cwd
    return {
      termId: rec.termId,
      label: rec.agentName ? `${rec.agentName} · ${cwdBase}` : `claude · ${cwdBase}`,
      cwd: rec.cwd,
      agentName: rec.agentName,
      color: rec.color,
      alive: rec.alive
    }
  }
}
