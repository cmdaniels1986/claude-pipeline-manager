import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeStatus, NodeType } from '../../../shared/types'
import { STATUS_STYLES } from './statusStyles'

export interface PipelineNodeData {
  label: string
  nodeType: NodeType
  status: NodeStatus
  statusNote?: string
  path?: string
  owner?: string
  placeholder?: boolean
  inCycle?: boolean
  deadEnd?: boolean
  orphan?: boolean
  changed?: boolean
  [key: string]: unknown
}

export function PipelineNode({ data, selected }: NodeProps): React.JSX.Element {
  const d = data as PipelineNodeData
  const style = STATUS_STYLES[d.status]
  const marks: { key: string; cls: string; text: string; title: string }[] = []
  if (d.changed) marks.push({ key: 'chg', cls: 'mark-changed', text: '✎ changed', title: 'Source file changed in the current git branch' })
  if (d.inCycle) marks.push({ key: 'cyc', cls: 'mark-cycle', text: '⟳ cycle', title: 'Part of a dependency cycle' })
  if (d.deadEnd) marks.push({ key: 'end', cls: 'mark-deadend', text: '⊣ dead-end', title: 'Produced but nothing downstream consumes it' })
  if (d.orphan) marks.push({ key: 'orp', cls: 'mark-orphan', text: '⊘ orphan', title: 'No lineage recorded — disconnected from the pipeline' })

  return (
    <div
      className={`pipeline-node${d.placeholder ? ' placeholder' : ''}${selected ? ' selected' : ''}${d.changed ? ' is-changed' : ''}${d.inCycle ? ' is-cycle' : ''}`}
      style={{
        borderColor: d.inCycle ? '#ff4d6d' : style.border,
        boxShadow: d.status === 'unknown' && !selected && !d.inCycle && !d.changed ? 'none' : `0 0 12px ${d.inCycle ? 'rgba(255,77,109,0.5)' : style.glow}`
      }}
      title={[d.path, d.owner && `owner: ${d.owner}`, d.statusNote].filter(Boolean).join('\n') || undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="pipeline-node-top">
        <span className="pipeline-node-type">{d.nodeType}</span>
        <span className="pipeline-node-status" style={{ color: style.dot }}>
          ● {style.label}
        </span>
      </div>
      <div className="pipeline-node-label">{d.label}</div>
      {d.owner && <div className="pipeline-node-owner">👤 {d.owner}</div>}
      {marks.length > 0 && (
        <div className="pipeline-node-marks">
          {marks.map((m) => (
            <span key={m.key} className={`node-mark ${m.cls}`} title={m.title}>
              {m.text}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
