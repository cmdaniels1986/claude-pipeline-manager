import { useEffect, useState } from 'react'
import { AGENT_COLORS, type AgentInfo } from '../../../shared/types'
import { useTerminalStore } from '../stores/terminalStore'

const NO_AGENT = '__none__'
const NEW_AGENT = '__new__'

export function NewTerminalDialog({
  defaultCwd,
  onClose
}: {
  defaultCwd: string | null
  onClose: () => void
}): React.JSX.Element {
  const addPane = useTerminalStore((s) => s.addPane)
  const paneCount = useTerminalStore((s) => s.panes.length)
  const [cwd, setCwd] = useState(defaultCwd ?? '')
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentChoice, setAgentChoice] = useState(NO_AGENT)
  const [newAgentName, setNewAgentName] = useState('')
  const [model, setModel] = useState('')
  const [color, setColor] = useState<string>(AGENT_COLORS[paneCount % AGENT_COLORS.length])
  const [dangerous, setDangerous] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshAgents = (): void => {
    void window.api.agentsList().then(setAgents)
  }

  useEffect(() => {
    refreshAgents()
    return window.api.onAgentsChanged(refreshAgents)
  }, [])

  const browse = async (): Promise<void> => {
    const picked = await window.api.pickFolder()
    if (picked) setCwd(picked)
  }

  const createAgent = async (): Promise<void> => {
    try {
      const info = await window.api.agentsCreateStarter(newAgentName)
      refreshAgents()
      setAgentChoice(info.name)
      setNewAgentName('')
      setError(`Starter agent written to ${info.filePath} — edit it to define the agent's role.`)
    } catch (err) {
      setError(String(err))
    }
  }

  const launch = async (): Promise<void> => {
    if (!cwd.trim()) {
      setError('Pick a working folder first.')
      return
    }
    if (!defaultCwd) await window.api.setActiveProject(cwd.trim())
    addPane({
      cwd: cwd.trim(),
      agentName: agentChoice !== NO_AGENT && agentChoice !== NEW_AGENT ? agentChoice : undefined,
      model: model.trim() || undefined,
      color,
      dangerous
    })
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New Claude terminal</h3>

        <label>Working folder</label>
        <div className="row">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\path\to\project"
            spellCheck={false}
          />
          <button onClick={() => void browse()}>Browse…</button>
        </div>

        <label>Agent</label>
        <select value={agentChoice} onChange={(e) => setAgentChoice(e.target.value)}>
          <option value={NO_AGENT}>No agent (plain Claude)</option>
          {agents.map((a) => (
            <option key={a.filePath} value={a.name}>
              {a.name}
              {a.description ? ` — ${a.description.slice(0, 60)}` : ''}
            </option>
          ))}
          <option value={NEW_AGENT}>➕ New agent…</option>
        </select>

        {agentChoice === NEW_AGENT && (
          <div className="row">
            <input
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              placeholder="agent-name"
              spellCheck={false}
            />
            <button onClick={() => void createAgent()} disabled={!newAgentName.trim()}>
              Create
            </button>
          </div>
        )}

        <label>Model (optional)</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="default from your settings"
          spellCheck={false}
        />

        <label>Agent color</label>
        <div className="color-row">
          {AGENT_COLORS.map((c) => (
            <button
              key={c}
              className={`color-swatch${color === c ? ' selected' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
            />
          ))}
        </div>

        <label className={`danger-check${dangerous ? ' armed' : ''}`}>
          <input type="checkbox" checked={dangerous} onChange={(e) => setDangerous(e.target.checked)} />
          <span>
            💀 Boot Dangerously!
            <span className="danger-sub">
              Skips all permission prompts (--dangerously-skip-permissions). This session can edit
              files and run commands with no confirmation — only for folders you trust.
            </span>
          </span>
        </label>

        {error && <p className="modal-note">{error}</p>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className={dangerous ? 'danger' : 'primary'} onClick={() => void launch()}>
            {dangerous ? '💀 Boot Dangerously' : 'Launch'}
          </button>
        </div>
      </div>
    </div>
  )
}
