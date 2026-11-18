import { toast } from 'sonner'

import { resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import { getConnectionId } from '@/lib/connection-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { findRepoCheckoutWorktree } from '@/lib/repo-checkout-worktree'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Repo } from '../../../shared/repo-types'

/**
 * Open a TUI agent in the repo's checkout and reveal it. The agent is the user's default one, or
 * the shared auto-pick order when no default is set — the same resolution the `tab.newAgent` chord
 * uses, so the project entry and the keyboard entry cannot disagree.
 *
 * Returns false (after a toast) when there is no checkout or no agent CLI: a project row can exist
 * before its worktree listing has landed, and that is a message, not a silent no-op.
 */
export function startAgentInRepoCheckout(repo: Repo): boolean {
  const state = useAppStore.getState()
  const worktree = findRepoCheckoutWorktree(state.worktreesByRepo, repo.id)
  if (!worktree) {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeList.openAgentNoCheckout',
        'This project has no workspace on this host yet.'
      )
    )
    return false
  }
  // Why the connection id: a remote checkout's agents are the remote host's, not the client's.
  const connectionId = getConnectionId(worktree.id)
  const agent = resolveDefaultAgentForNewTab({
    defaultTuiAgent: state.settings?.defaultTuiAgent,
    detectedAgentIds:
      typeof connectionId === 'string'
        ? state.remoteDetectedAgentIds[connectionId]
        : state.detectedAgentIds,
    disabledTuiAgents: state.settings?.disabledTuiAgents
  })
  if (!agent) {
    toast.error(
      translate(
        'auto.components.Terminal.5b2c1a9e44',
        'No agent CLI detected — install one or pick a default agent in Settings.'
      )
    )
    return false
  }
  // Why activate first: the new tab is created in this worktree's tab list, and the user asked for
  // it from a row that may not be the active workspace.
  activateAndRevealWorktree(worktree.id)
  const launched = launchAgentInNewTab({
    agent,
    worktreeId: worktree.id,
    launchSource: 'sidebar'
  })
  return launched !== null
}
