import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { formatWorktreeShow, printResult } from '../format'
import { printHookWarning } from './worktree-removal-warnings'
import { printLineageSummary } from './worktree-lineage-summary'

/**
 * The runtime is honest about this already: `agentTerminalHandle` / `startupTerminal.handle`
 * only appear when an agent owns the first terminal, and a create without `--agent` records no
 * `createdWithAgent`. What was missing is a field a caller can branch on, so `--issue` without
 * `--agent` used to look exactly like a started-agent create in `--json`.
 *
 * Derived from the receipt, never from the flags: a requested agent whose startup failed must
 * read as `agentStarted: false`, not as "we asked for one".
 */
export type AgentStartupReceipt = {
  agentTerminalHandle?: string
  startupTerminal?: { spawned?: boolean; handle?: string }
  warning?: string
  agentStarted?: boolean
}

export function annotateCreateAgentStartup<T extends AgentStartupReceipt>(
  result: T,
  options: { requestedAgent?: string; issueLinked: boolean }
): T {
  const handle = result.agentTerminalHandle ?? result.startupTerminal?.handle
  result.agentStarted = typeof handle === 'string' && handle.length > 0
  if (result.agentStarted || options.requestedAgent !== undefined || !options.issueLinked) {
    return result
  }
  // Why a warning instead of a failure: the workspace and its issue link are real and usable.
  // Reporting the half outcome beats refusing a create the caller may have wanted as a shell.
  const warning =
    'issue-linked workspace created without an agent: pass --agent <id> --prompt "<text>" to start one in the first terminal (agentStarted: false).'
  result.warning = result.warning ? `${result.warning} ${warning}` : warning
  return result
}

/**
 * Print a `worktree create` receipt with the agent-startup verdict attached.
 *
 * `issueLinked` is deliberately the caller's question ("did you ask to open a workspace for this
 * ticket?"), not every create: a plain `--name` create is a legitimate shell workspace and must
 * stay quiet.
 */
export function printCreatedWorktree(
  response: RuntimeRpcSuccess<RuntimeWorktreeCreateResult>,
  requestedAgent: string | undefined,
  issueLinked: boolean,
  json: boolean
): void {
  annotateCreateAgentStartup(response.result, { requestedAgent, issueLinked })
  printHookWarning(response.result, json)
  printLineageSummary(response.result, json)
  printResult(response, json, formatWorktreeShow)
}
