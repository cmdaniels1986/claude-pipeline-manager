import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Each terminal gets its own tiny mcp-config file whose only job is to point the
 * session at the shared graph server and stamp the terminal id on every request.
 * File-based (never inline JSON args) to dodge Windows CLI quoting.
 */
export function writeMcpConfigFile(baseDir: string, termId: string, port: number): string {
  const dir = join(baseDir, 'mcp')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${termId}.json`)
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          graph: {
            type: 'http',
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { 'X-Terminal-Id': termId }
          }
        }
      },
      null,
      2
    )
  )
  return path
}
