import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { buildAgentStartupPlan } from '../../../../../../shared/tui-agent-startup'
import type * as OrchestrationCli from '../../../../orchestration/cli-command'
import { buildWorkerMailboxBootstrap } from './worker-mailbox-bootstrap'

vi.mock('../../../../orchestration/cli-command', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationCli>()),
  nativeOrchestrationCliCommand: () => "'/owning host/cli/orca'",
  runtimeOrchestrationCliCommand: () => undefined
}))

afterEach(() => vi.restoreAllMocks())

describe('Worker argv mailbox bootstrap', () => {
  const runtime = new OrcaRuntimeService()
  const ids = { taskId: 'task_boot', dispatchId: 'ctx_boot' }

  function workspace(connectionId: string | null = null, id = 'repo::/folder::workspace:unique') {
    vi.spyOn(runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue({
      id,
      connectionId,
      path: '/folder',
      repo: null,
      folderWorkspace: null
    })
    return buildWorkerMailboxBootstrap({ runtime, target: { worktreeId: id }, ...ids })
  }

  it('uses the owning CLI and injected identity for folder as well as git workspaces', async () => {
    const prompt = await workspace()
    expect(prompt).toContain(
      "'/owning host/cli/orca' orchestration check --wait --timeout-ms 1000 --json"
    )
    expect(prompt).toContain(
      "'/owning host/cli/orca' orchestration check --ack <deliveryId> --json"
    )
    expect(prompt).toContain('Expected Task: task_boot; expected Dispatch: ctx_boot')
    expect(prompt).toContain('Do not use --run')
    expect(prompt).toContain('never execute it twice')
    expect(prompt).toContain('Stop on other errors')
  })

  it.each(['linux', 'darwin', 'win32'] as const)(
    'carries the bootstrap in argv on %s',
    async (platform) => {
      const prompt = await workspace()
      const plan = buildAgentStartupPlan({ agent: 'trae', prompt, platform, cmdOverrides: {} })
      expect(plan?.followupPrompt).toBeNull()
      expect(plan?.launchCommand).toContain('Expected Task: task_boot')
      expect(plan?.launchCommand).toContain('orchestration check --wait')
    }
  )

  it('uses the SSH relay command without leaking a local launcher', async () => {
    const prompt = await workspace('ssh_target')
    expect(prompt).toContain('\norca orchestration check --wait')
    expect(prompt).not.toContain('/owning host/')
  })

  it('resolves the selected new-worktree repo, including executionHostId-only SSH routing', async () => {
    const show = vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'other',
      path: '/remote/repo',
      displayName: 'Other',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'ssh:other-host'
    })
    const prompt = await buildWorkerMailboxBootstrap({
      runtime,
      target: { repoSelector: 'id:other' },
      ...ids
    })
    expect(show).toHaveBeenCalledWith('id:other')
    expect(prompt).toContain('\norca orchestration check --wait')
    expect(prompt).not.toContain('/owning host/')
  })

  it('respects a local project WSL execution preference before a PTY exists', async () => {
    vi.spyOn(runtime, 'resolveProjectRuntimeForWorktree').mockReturnValue({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'p',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'project:wsl:Ubuntu'
      }
    })
    const prompt = await workspace(null, 'repo::C:\\repo')
    expect(prompt).toContain('\norca-ide orchestration check --wait')
    expect(prompt).not.toContain('/owning host/')
  })

  it('does not fall back locally when the requested host refuses resolution', async () => {
    vi.spyOn(runtime, 'showTerminalWorkspaceLaunchScope').mockRejectedValue(
      new Error('runtime_access_denied')
    )
    await expect(
      buildWorkerMailboxBootstrap({
        runtime,
        target: { worktreeId: 'remote::/repo' },
        ...ids
      })
    ).rejects.toThrow('runtime_access_denied')
  })
})
