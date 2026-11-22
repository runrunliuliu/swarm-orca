import { useAppStore } from '@/store'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { reportAgentPromptDeliveryFailure } from '@/lib/agent-prompt-delivery-failure'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { seedAgentTabStateAfterWorktreeCreate } from '@/lib/worktree-creation-agent-seeds'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

export async function completeWorktreeCreation(args: {
  creationId: string
  request: WorktreeCreationRequest
  worktreeId: string
  structuredLaunchAccepted: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  startupTerminalTabId?: string
  backendSpawned: boolean
  focusOnCompletion: boolean
}): Promise<void> {
  const { request } = args
  // Why: clearing synchronously after activation lets React commit the panel-to-terminal swap in one frame.
  useAppStore.getState().removePendingWorktreeCreation(args.creationId, { cleanupVm: false })
  if (!args.structuredLaunchAccepted) {
    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: args.worktreeId,
      primaryTabId: args.primaryTabId,
      startupTerminalTabId: args.startupTerminalTabId,
      backendSpawned: args.backendSpawned
    })
  }
  if (!args.structuredLaunchAccepted && request.startupPlan && !args.backendSpawned) {
    void ensureAgentStartupInTerminal({
      worktreeId: args.worktreeId,
      primaryTabId: args.primaryTabId,
      startup: request.startupPlan,
      // Why: the composer decided delivery before the worktree existed; the paste must not
      // re-derive it, or a retry could submit a prompt the user chose to leave editable.
      submitDraft: request.promptDelivery === 'submit-after-ready'
    }).catch((error: unknown) => {
      // Why: this call is deliberately not awaited, so an unhandled rejection here is the
      // quietest way to lose a launch prompt — surface it instead (#54).
      console.warn('Agent startup delivery failed after worktree creation', error)
      reportAgentPromptDeliveryFailure(request.agent)
    })
  }
  if (
    !args.structuredLaunchAccepted &&
    !request.suppressTerminalFocusOnCompletion &&
    args.focusOnCompletion
  ) {
    queueWorkspaceActivationTerminalFocus(args.worktreeId, args.activation)
  }

  // Why: note persistence is cosmetic and should not delay the visible workspace handoff.
  if (request.note) {
    try {
      await useAppStore.getState().updateWorktreeMeta(args.worktreeId, { comment: request.note })
    } catch {
      console.error('Failed to update worktree meta after creation')
    }
  }
}
