import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  isAgentHookEndpointFileName,
  parseAgentHookEndpointFile,
  type AgentHookEndpoint
} from '../../../src/shared/agent-hook-endpoint-file'

/**
 * The orcad hook endpoint, read off the profile instead of off an Electron app: the server writes
 * `<userData>/agent-hooks[/<namespace>]/endpoint.env` (`server-runtime-env.ts:55-59`), and a POST to
 * `http://127.0.0.1:<port>/hook/<agent>` with `X-Orca-Agent-Hook-Token` is the same wire shape a real
 * agent produces.
 */
function findEndpointEnvFile(root: string): string | null {
  if (!existsSync(root)) {
    return null
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isFile() && isAgentHookEndpointFileName(entry.name)) {
      return fullPath
    }
    if (entry.isDirectory()) {
      const nested = findEndpointEnvFile(fullPath)
      if (nested) {
        return nested
      }
    }
  }
  return null
}

export function readOrcadHookEndpoint(userDataDir: string): AgentHookEndpoint | null {
  const endpointPath = findEndpointEnvFile(path.join(userDataDir, 'agent-hooks'))
  return endpointPath ? parseAgentHookEndpointFile(readFileSync(endpointPath, 'utf8')) : null
}

export async function waitForOrcadHookEndpoint(
  userDataDir: string,
  timeoutMs = 30_000
): Promise<AgentHookEndpoint> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const endpoint = readOrcadHookEndpoint(userDataDir)
    if (endpoint) {
      return endpoint
    }
    if (Date.now() > deadline) {
      throw new Error(`Agent hook endpoint file not found under ${userDataDir}/agent-hooks`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
