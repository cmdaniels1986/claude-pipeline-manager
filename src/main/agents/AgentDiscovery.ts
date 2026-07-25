import { watch, type FSWatcher } from 'chokidar'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import matter from 'gray-matter'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { AgentInfo } from '../../shared/types'

const STARTER_TEMPLATE = (name: string) => `---
name: ${name}
description: Describe what this agent is for (shown in the launcher dropdown)
---

You are the "${name}" agent. Describe the agent's role, expertise, and working style here.
This body becomes the agent's system prompt.
`

export class AgentDiscovery extends EventEmitter {
  private watcher: FSWatcher | null = null
  private projectRoot: string | null = null

  userAgentsDir(): string {
    return join(homedir(), '.claude', 'agents')
  }

  setProjectRoot(root: string | null): void {
    this.projectRoot = root
    this.restartWatcher()
  }

  list(): AgentInfo[] {
    const out: AgentInfo[] = []
    this.scanDir(this.userAgentsDir(), 'user', out)
    if (this.projectRoot) {
      this.scanDir(join(this.projectRoot, '.claude', 'agents'), 'project', out)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  createStarter(name: string): AgentInfo {
    const safe = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!safe) throw new Error('Agent name is empty after sanitizing')
    const dir = this.userAgentsDir()
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${safe}.md`)
    if (existsSync(filePath)) throw new Error(`Agent "${safe}" already exists`)
    writeFileSync(filePath, STARTER_TEMPLATE(safe))
    this.restartWatcher()
    return { name: safe, source: 'user', filePath }
  }

  dispose(): void {
    void this.watcher?.close()
    this.watcher = null
  }

  private scanDir(dir: string, source: AgentInfo['source'], out: AgentInfo[]): void {
    if (!existsSync(dir)) return
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
    } catch {
      return
    }
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const parsed = matter(readFileSync(filePath, 'utf8'))
        const fm = parsed.data as Record<string, unknown>
        out.push({
          name: typeof fm.name === 'string' && fm.name ? fm.name : basename(file, '.md'),
          description: typeof fm.description === 'string' ? fm.description : undefined,
          model: typeof fm.model === 'string' ? fm.model : undefined,
          tools: Array.isArray(fm.tools)
            ? fm.tools.map(String)
            : typeof fm.tools === 'string'
              ? fm.tools.split(',').map((t) => t.trim()).filter(Boolean)
              : undefined,
          source,
          filePath
        })
      } catch {
        // unparseable file — skip
      }
    }
  }

  private restartWatcher(): void {
    void this.watcher?.close()
    this.watcher = null
    const dirs = [this.userAgentsDir()]
    if (this.projectRoot) dirs.push(join(this.projectRoot, '.claude', 'agents'))
    const existing = dirs.filter((d) => existsSync(d))
    if (!existing.length) return
    this.watcher = watch(existing, { ignoreInitial: true, depth: 0 })
    let timer: NodeJS.Timeout | null = null
    this.watcher.on('all', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => this.emit('changed'), 200)
    })
  }
}
