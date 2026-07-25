import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeStatus, NodeType } from '../../../shared/types'
import { STATUS_STYLES } from './statusStyles'

export interface PipelineNodeData {
  label: string
  nodeType: NodeType
  status: NodeStatus
  statusNote?: string
  path?: string
  placeholder?: boolean
  [key: string]: unknown
}

export function PipelineNode({ data, selected }: NodeProps): React.JSX.Element {
  const d = data as PipelineNodeData
  const style = STATUS_STYLES[d.status]
  return (
    <div
      className={`pipeline-node${d.placeholder ? ' placeholder' : ''}${selected ? ' selected' : ''}`}
      style={{
        borderColor: style.border,
        boxShadow: d.status === 'unknown' && !selected ? 'none' : `0 0 12px ${style.glow}`
      }}
      title={[d.path, d.statusNote].filter(Boolean).join('\n') || undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="pipeline-node-top">
        <span className="pipeline-node-type">{d.nodeType}</span>
        <span className="pipeline-node-status" style={{ color: style.dot }}>
          ● {style.label}
        </span>
      </div>
      <div className="pipeline-node-label">{d.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
