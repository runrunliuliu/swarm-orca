import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  closeTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  setActiveTabType: vi.fn()
}))

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: 'web-runtime' as string | null
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] as { id: string; launchAgent?: string }[] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  sshConnectionStates: new Map(),
  transientClearedAgentStatusConnectionIds: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  createTab: mocks.createTab,
  closeTab: mocks.closeTab,
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: vi.fn(() => true),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

import { toast } from 'sonner'

describe('launchAgentInNewTab paired web runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
  })

  it('delegates agent quick launch to the host runtime', async () => {
    store.tabsByWorktree['wt-1'].push({ id: 'stale-agent-tab', launchAgent: 'claude' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentSessionKind: 'fresh',
      agent: 'claude',
      viewMode: 'terminal'
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
    await Promise.resolve()
    // Why: host creation is async, so the user may be viewing another worktree by the time it lands.
    expect(mocks.setActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', 'wt-1')
    expect(mocks.closeTab).toHaveBeenCalledWith('stale-agent-tab', { reason: 'cleanup' })
  })

  it('forwards explicit spawned-from provenance to paired host runtime launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const parentPaneKey = 'parent-tab:11111111-1111-4111-8111-111111111111'

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      spawnedFromPaneKey: parentPaneKey
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' }
      })
    )
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        agentSessionKind: 'fresh',
        agent: 'claude',
        spawnedFromPaneKey: parentPaneKey
      })
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('forwards prompt launch env and captured config to the host runtime', async () => {
    store.settings.agentDefaultArgs = { codex: '--model gpt-5 --reasoning-effort high' }
    store.settings.agentDefaultEnv = { codex: { CODEX_PROFILE: 'captured' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentSessionKind: 'fresh',
      launchAgent: 'codex',
      command: "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'fix the spinner'",
      env: { CODEX_PROFILE: 'captured' },
      launchConfig: {
        agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      startupCommandDelivery: 'shell-ready',
      prompt: 'fix the spinner',
      promptDelivery: 'auto-submit',
      viewMode: 'terminal'
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('shows an actionable message instead of the raw selector code when the host cannot resolve the worktree', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'selector_not_found'
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("Orca couldn't resolve this workspace on its host right now")
    )
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
      expect.stringContaining('selector_not_found')
    )
  })
})
