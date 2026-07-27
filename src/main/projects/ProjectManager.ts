import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProjectInfo } from '../../shared/types'

interface IndexShape {
  version: 1
  activeId: string | null
  projects: ProjectInfo[]
}

const now = (): string => new Date().toISOString()

/**
 * The app manages its own library of projects (workspaces) instead of the user
 * picking folders on disk. Each project is a folder under
 * <userData>/projects/<id>/, and its graph/tasks persist inside it exactly as
 * before (<root>/.claude-manager/*.json). A single index file tracks the
 * friendly names and which project is active, so everything is auto-saved and
 * survives restarts with no folder-picking.
 */
export class ProjectManager {
  private dir: string
  private indexPath: string
  private index: IndexShape

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'projects')
    this.indexPath = join(userDataDir, 'projects.json')
    mkdirSync(this.dir, { recursive: true })
    this.index = this.load()
  }

  private load(): IndexShape {
    if (existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.indexPath, 'utf8'))
        if (raw && Array.isArray(raw.projects)) {
          // re-derive roots from the current data dir so the library survives the
          // app-data path moving (new machine, different drive, etc.)
          const projects: ProjectInfo[] = raw.projects.map((p: ProjectInfo) => ({
            ...p,
            root: join(this.dir, p.id)
          }))
          return { version: 1, activeId: raw.activeId ?? null, projects }
        }
      } catch (err) {
        console.error('projects.json unreadable, starting fresh:', err)
      }
    }
    return { version: 1, activeId: null, projects: [] }
  }

  private save(): void {
    try {
      const tmp = this.indexPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.index, null, 2))
      renameSync(tmp, this.indexPath)
    } catch (err) {
      console.error('Failed to save projects.json:', err)
    }
  }

  list(): ProjectInfo[] {
    return this.index.projects
  }

  activeId(): string | null {
    return this.index.activeId
  }

  getActive(): ProjectInfo | null {
    return this.index.projects.find((p) => p.id === this.index.activeId) ?? null
  }

  create(name: string): ProjectInfo {
    const id = `p-${randomUUID().slice(0, 8)}`
    const root = join(this.dir, id)
    mkdirSync(root, { recursive: true })
    const ts = now()
    const info: ProjectInfo = {
      id,
      name: name.trim() || 'Untitled project',
      root,
      createdAt: ts,
      lastOpenedAt: ts
    }
    this.index.projects.push(info)
    this.index.activeId = id
    this.save()
    return info
  }

  rename(id: string, name: string): void {
    const p = this.index.projects.find((x) => x.id === id)
    if (p && name.trim()) {
      p.name = name.trim()
      this.save()
    }
  }

  /** Removes a project from the library AND deletes its folder (graph + tasks). */
  remove(id: string): void {
    const p = this.index.projects.find((x) => x.id === id)
    this.index.projects = this.index.projects.filter((x) => x.id !== id)
    if (this.index.activeId === id) this.index.activeId = this.index.projects[0]?.id ?? null
    if (p) {
      try {
        rmSync(p.root, { recursive: true, force: true })
      } catch (err) {
        console.error(`Failed to delete project folder ${p.root}:`, err)
      }
    }
    this.save()
  }

  setActive(id: string): ProjectInfo | null {
    const p = this.index.projects.find((x) => x.id === id)
    if (!p) return null
    this.index.activeId = id
    p.lastOpenedAt = now()
    this.save()
    return p
  }

  /** Point a project's goals & tasks at a shared, cloud-synced folder (or pass
   *  null to move them back into local app-data). Does not itself migrate the
   *  existing tasks — the caller re-inits the store and imports them. */
  setSharedTasksPath(id: string, folderPath: string | null): ProjectInfo | null {
    const p = this.index.projects.find((x) => x.id === id)
    if (!p) return null
    if (folderPath && folderPath.trim()) {
      mkdirSync(folderPath, { recursive: true })
      p.sharedTasksPath = folderPath
    } else {
      delete p.sharedTasksPath
    }
    this.save()
    return p
  }

  /** Absolute path to a project's tasks.json — the shared folder when shared,
   *  otherwise inside the project's local app-data folder. */
  tasksFilePathFor(info: ProjectInfo): string {
    return info.sharedTasksPath
      ? join(info.sharedTasksPath, 'tasks.json')
      : join(info.root, '.claude-manager', 'tasks.json')
  }

  /** Guarantees there is always an active project (creates a default on first run). */
  ensureDefault(): ProjectInfo {
    let active = this.getActive()
    if (!active) {
      active = this.index.projects[0] ?? this.create('My First Project')
      this.index.activeId = active.id
      this.save()
    }
    // the folder may have been deleted out from under us — recreate it
    mkdirSync(active.root, { recursive: true })
    return active
  }
}
