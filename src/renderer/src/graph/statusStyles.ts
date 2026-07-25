import type { NodeStatus } from '../../../shared/types'

export interface StatusStyle {
  border: string
  glow: string
  dot: string
  label: string
}

export const STATUS_STYLES: Record<NodeStatus, StatusStyle> = {
  unknown: { border: '#3d444d', glow: 'transparent', dot: '#8b949e', label: 'unknown' },
  in_progress: { border: '#d29922', glow: 'rgba(210,153,34,0.35)', dot: '#e3b341', label: 'in progress' },
  validated: { border: '#2ea043', glow: 'rgba(46,160,67,0.30)', dot: '#3fb950', label: 'validated' },
  stale: { border: '#db6d28', glow: 'rgba(219,109,40,0.35)', dot: '#f0883e', label: 'stale' },
  breaking: { border: '#da3633', glow: 'rgba(218,54,51,0.45)', dot: '#f85149', label: 'BREAKING' }
}
