import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeTerminalWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalListResult, RuntimeTerminalRead } from '../../../shared/runtime-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

/** What the dock renders: the agent terminal's tail, newest last. */
export type TaskDockTranscriptRead = {
  lines: string[]
  ended: boolean
}

const LIST_LIMIT = 200
const TRANSCRIPT_TIMEOUT_MS = 10_000

/**
 * The tail of the draft's agent terminal, read through the runtime so the dock does not need the
 * agent's tab to be on screen. Two calls, both read-only: `terminal.list` finds the handle bound
 * to the draft's primary tab, then `terminal.read` returns its accumulated output.
 *
 * Null means "nothing to show yet" — no session, no terminal, or a host that could not answer.
 * A poll must never turn a transient read into a dock error.
 */
export async function readTaskDockTranscript(args: {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  folderWorkspaceId: string
  primaryTabId: string | null
  limit?: number
}): Promise<TaskDockTranscriptRead | null> {
  if (!args.primaryTabId) {
    return null
  }
  const target = getActiveRuntimeTarget(args.settings)
  const worktree = toRuntimeTerminalWorktreeSelector(folderWorkspaceKey(args.folderWorkspaceId))
  try {
    const listing = await callRuntimeRpc<RuntimeTerminalListResult>(
      target,
      'terminal.list',
      { worktree, limit: LIST_LIMIT },
      { timeoutMs: TRANSCRIPT_TIMEOUT_MS }
    )
    // Why the tab and not the first terminal: a draft tab may hold splits and a fallback shell, and
    // the dock's follow-up goes to the agent tab's session.
    const summary = listing.terminals.find((terminal) => terminal.tabId === args.primaryTabId)
    if (!summary) {
      return null
    }
    const read = await callRuntimeRpc<{ terminal: RuntimeTerminalRead }>(
      target,
      'terminal.read',
      { terminal: summary.handle, ...(args.limit ? { limit: args.limit } : {}) },
      { timeoutMs: TRANSCRIPT_TIMEOUT_MS }
    )
    return {
      lines: read.terminal.tail,
      // Why both signals: a detached summary means the host lost the PTY, an exited status means
      // the agent process is gone. Either way the tail is final, not merely stale.
      ended: summary.connected === false || read.terminal.status === 'exited'
    }
  } catch {
    return null
  }
}
