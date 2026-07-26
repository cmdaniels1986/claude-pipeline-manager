import type { NodeStatus } from '../../../shared/types'

export interface StatusStyle {
  border: string
  glow: string
  dot: string
  label: string
}

export const STATUS_STYLES: Record<NodeStatus, StatusStyle> = {
  unknown: { border: 'rgba(64,224,208,0.35)', glow: 'transparent', dot: '#6f938d', label: 'unknown' },
  in_progress: { border: '#f5c451', glow: 'rgba(245,196,81,0.4)', dot: '#f5c451', label: 'in progress' },
  validated: { border: '#2fe6a6', glow: 'rgba(47,230,166,0.4)', dot: '#2fe6a6', label: 'validated' },
  stale: { border: '#ff9a3d', glow: 'rgba(255,154,61,0.4)', dot: '#ff9a3d', label: 'stale' },
  breaking: { border: '#ff4d6d', glow: 'rgba(255,77,109,0.5)', dot: '#ff4d6d', label: 'BREAKING' }
}
