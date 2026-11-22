import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'

const mocks = vi.hoisted(() => ({
  ensureAgentStartupInTerminal: vi.fn(),
  reportAgentPromptDeliveryFailure: vi.fn(),
  removePendingWorktreeCreation: vi.fn(),
  queueWorkspaceActivationTerminalFocus: vi.fn(),
  seedAgentTabStateAfterWorktreeCreate: vi.fn(),
  updateWorktreeMeta: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      removePendingWorktreeCreation: mocks.removePendingWorktreeCreation,
      updateWorktreeMeta: mocks.updateWorktreeMeta
    })
  }
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal
}))

vi.mock('@/lib/agent-prompt-delivery-failure', () => ({
  reportAgentPromptDeliveryFailure: mocks.reportAgentPromptDeliveryFailure
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: mocks.queueWorkspaceActivationTerminalFocus
}))

vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: mocks.seedAgentTabStateAfterWorktreeCreate
}))

import { completeWorktreeCreation } from './worktree-creation-completion'

const request: WorktreeCreationRequest = {
  repoId: 'repo-1',
  name: 'feature',
  setupDecision: 'inherit',
  agent: 'codex',
  agentLaunchRoute: 'terminal-tui',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: {
    agent: 'codex',
    launchCommand: 'codex',
    expectedProcess: 'codex',
    followupPrompt: null,
    launchConfig: { agentArgs: '', agentEnv: {} },
    draftPrompt: 'Coordinator brief'
  },
  quickPrompt: 'Coordinator brief',
  promptDelivery: 'submit-after-ready',
  quickTelemetry: null
}

const completionArgs = {
  creationId: 'creation-1',
  request,
  worktreeId: 'worktree-1',
  structuredLaunchAccepted: false,
  activation: false as const,
  primaryTabId: 'tab-1',
  backendSpawned: false,
  focusOnCompletion: false
}

describe('completeWorktreeCreation startup delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureAgentStartupInTerminal.mockResolvedValue(undefined)
  })

  it('passes the composer-decided submit mode through to the pane delivery', async () => {
    await completeWorktreeCreation(completionArgs)

    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      primaryTabId: 'tab-1',
      startup: request.startupPlan,
      submitDraft: true
    })
    expect(mocks.reportAgentPromptDeliveryFailure).not.toHaveBeenCalled()
  })

  it('surfaces a rejected startup delivery instead of leaving it unobserved', async () => {
    // Why: this call is `void`ed on purpose; without a catch a failed delivery of the first
    // prompt disappeared with no toast and no event (#54).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mocks.ensureAgentStartupInTerminal.mockRejectedValue(new Error('pane write failed'))

    await completeWorktreeCreation(completionArgs)

    await vi.waitFor(() =>
      expect(mocks.reportAgentPromptDeliveryFailure).toHaveBeenCalledWith('codex')
    )
    warn.mockRestore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
