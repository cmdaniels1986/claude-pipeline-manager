import type { GraphEvent, TaskEvent } from '../../../shared/types'

/** One thing a terminal did, drawn from the graph or the goals/tasks board. */
export interface ActivityItem {
  ts: string
  source: 'graph' | 'task'
  summary: string
}

/**
 * What a terminal actually worked on: the graph + task events attributed to its
 * termId (the app's two records of agent activity), newest first. Human edits
 * (termId null) are excluded, so this is strictly what *this* terminal did.
 */
export function collectActivity(
  termId: string | undefined,
  graphEvents: readonly GraphEvent[] | undefined,
  taskEvents: readonly TaskEvent[] | undefined
): ActivityItem[] {
  if (!termId) return []
  const items: ActivityItem[] = []
  for (const e of graphEvents ?? []) {
    if (e.termId === termId) items.push({ ts: e.ts, source: 'graph', summary: e.summary })
  }
  for (const e of taskEvents ?? []) {
    if (e.termId === termId) items.push({ ts: e.ts, source: 'task', summary: e.summary })
  }
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)) // newest first
  return items
}

const MAX_LINES = 6

/**
 * A tooltip describing what a terminal worked on. Leads with the agent/cwd
 * context, then the most recent pipeline & task activity. Plain text with
 * newlines, sized for a native title tooltip.
 */
export function describeTerminal(
  pane: { cwd: string; agentName?: string; label: string },
  activity: readonly ActivityItem[]
): string {
  const lines: string[] = []
  lines.push(pane.agentName ? `${pane.label} · agent: ${pane.agentName}` : pane.label)
  lines.push(pane.cwd)
  lines.push('')

  if (!activity.length) {
    lines.push('No pipeline or task activity recorded yet.')
    return lines.join('\n')
  }

  const graphCount = activity.filter((a) => a.source === 'graph').length
  const taskCount = activity.length - graphCount
  const parts: string[] = []
  if (graphCount) parts.push(`${graphCount} pipeline update${graphCount === 1 ? '' : 's'}`)
  if (taskCount) parts.push(`${taskCount} task update${taskCount === 1 ? '' : 's'}`)
  lines.push(`Worked on — ${parts.join(' · ')}:`)

  for (const a of activity.slice(0, MAX_LINES)) {
    lines.push(`${a.source === 'graph' ? '◇' : '✓'} ${a.summary}`)
  }
  if (activity.length > MAX_LINES) lines.push(`  …and ${activity.length - MAX_LINES} more`)
  return lines.join('\n')
}
