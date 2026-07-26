export interface LaunchArgOptions {
  agentName?: string
  model?: string
  dangerous?: boolean
  mcpConfigPath: string
  protocolPath: string
  /** settings JSON file with a SessionStart hook that types the protocol — used when
   *  the installed CLI lacks --append-system-prompt-file */
  settingsFallbackPath: string
  hasAppendSystemPromptFile: boolean
}

export function buildLaunchArgs(o: LaunchArgOptions): string[] {
  const args: string[] = ['--mcp-config', o.mcpConfigPath]
  if (o.hasAppendSystemPromptFile) {
    args.push('--append-system-prompt-file', o.protocolPath)
  } else {
    args.push('--settings', o.settingsFallbackPath)
  }
  if (o.agentName) args.push('--agent', o.agentName)
  if (o.model) args.push('--model', o.model)
  if (o.dangerous) args.push('--dangerously-skip-permissions')
  return args
}
