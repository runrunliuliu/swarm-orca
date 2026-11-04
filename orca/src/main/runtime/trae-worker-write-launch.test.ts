import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { ResolvedTerminalWorkspaceLaunchTarget } from './orca-runtime-core'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

class LaunchRuntime extends OrcaRuntimeService {
  readonly target =
    vi.fn<
      (
        selector: string,
        options?: { materializePushTarget?: boolean }
      ) => Promise<ResolvedTerminalWorkspaceLaunchTarget>
    >()

  protected override resolveTerminalWorkspaceLaunchTarget(
    selector: string,
    options?: { materializePushTarget?: boolean }
  ): Promise<ResolvedTerminalWorkspaceLaunchTarget> {
    return this.target(selector, options)
  }
}

describe.skipIf(process.platform === 'win32')('Trae writable roots at terminal creation', () => {
  let fixture: string
  let evidence: string
  let target: ResolvedTerminalWorkspaceLaunchTarget
  let settings: ReturnType<RuntimeStore['getSettings']>
  let runtime: LaunchRuntime
  let spawn: ReturnType<typeof vi.fn<NonNullable<RuntimePtyController['spawn']>>>
  let kill: ReturnType<typeof vi.fn<RuntimePtyController['kill']>>

  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'orca-write-launch-')))
    evidence = join(fixture, 'evidence')
    const workspace = join(fixture, 'workspace')
    await Promise.all([workspace, evidence].map((path) => mkdir(path)))
    const folder: FolderWorkspace = {
      id: 'launch-test',
      projectGroupId: 'group',
      name: 'test',
      folderPath: workspace,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    const worktree = folderWorkspaceToWorktree(folder)
    target = {
      scope: {
        id: worktree.id,
        path: workspace,
        connectionId: null,
        repo: null,
        folderWorkspace: folder
      },
      managedWorktree: {
        ...worktree,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        git: { path: workspace, head: '', branch: '', isBare: false, isMainWorktree: false }
      }
    }
    settings = {
      workspaceDir: fixture,
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      branchPrefixCustom: '',
      agentCmdOverrides: { trae: 'traecli' },
      agentDefaultArgs: { trae: '--yolo --remote old' }
    }
    const unexpectedWrite = (): never => {
      throw new Error('Unexpected store mutation')
    }
    const store: RuntimeStore = {
      getRepos: () => [],
      getRepo: () => undefined,
      addRepo: unexpectedWrite,
      updateRepo: unexpectedWrite,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: unexpectedWrite,
      removeWorktreeMeta: unexpectedWrite,
      getGitHubCache: () => ({ pr: {}, issue: {} }),
      getSettings: () => settings
    }
    runtime = new LaunchRuntime(store)
    runtime.target.mockImplementation(async () => target)
    spawn = vi
      .fn<NonNullable<RuntimePtyController['spawn']>>()
      .mockResolvedValue({ id: 'pty-test' })
    kill = vi.fn<RuntimePtyController['kill']>().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(fixture, { recursive: true, force: true })
  })

  async function options(): Promise<TerminalCreateOptions> {
    const constraint = await runtime.prepareOrchestrationTraeWorkspaceWrite(target.scope.id, [
      evidence
    ])
    return {
      startupAgent: 'trae',
      launchSource: 'orchestration',
      requireFreshPane: true,
      agentArgs: constraint.agentArgs,
      traeWorkspaceWrite: constraint,
      launchPreferences: { model: 'gpt-5.5', effort: 'high', backendVariant: 'max' }
    }
  }

  it('revalidates a folder workspace, forwards model options and replaces shared default args', async () => {
    const opts = await options()
    await runtime.createTerminal(`id:${target.scope.id}`, opts)
    const request = spawn.mock.calls[0]?.[0]
    expect(request?.cwd).toBe(target.scope.path)
    expect(request?.launchAgent).toBe('trae')
    expect(request?.env?.DISABLE_AUTO_UPDATE).toBe('true')
    expect(tokenizeStartupCommand(request?.command ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: [
        'traecli',
        '--no-daemon',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'never',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--add-dir',
        evidence,
        '--model',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'model_backend_variant="max"'
      ]
    })
    expect(runtime.target.mock.calls.map((call) => call[1])).toEqual([
      { materializePushTarget: false },
      undefined,
      { materializePushTarget: false }
    ])
    expect(settings.agentDefaultArgs?.trae).toBe('--yolo --remote old')
    expect(opts.traeWorkspaceWrite?.receipt.actualSessionVerified).toBe(false)
  })

  it('does not disable shell updates for ordinary Trae terminals', async () => {
    await runtime.createTerminal(`id:${target.scope.id}`, { startupAgent: 'trae' })
    expect(spawn.mock.calls[0]?.[0].env?.DISABLE_AUTO_UPDATE).toBeUndefined()
  })

  it('mints proof for native Trae exec and retires it when the Agent exits to its shell', async () => {
    const terminal = await runtime.createTerminal(`id:${target.scope.id}`, {
      startupAgent: 'trae',
      agentArgs: `exec --json --model gpt-5.5 'Pinned task with "quotes" and $(literal)'`
    })
    const request = spawn.mock.calls[0]?.[0]
    const proof = {
      terminalHandle: terminal.handle,
      paneKey: request?.env?.ORCA_PANE_KEY,
      launchToken: request?.env?.ORCA_AGENT_LAUNCH_TOKEN
    }
    expect(request?.launchAgent).toBe('trae')
    expect(tokenizeStartupCommand(request?.command ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: [
        'traecli',
        'exec',
        '--json',
        '--model',
        'gpt-5.5',
        'Pinned task with "quotes" and $(literal)'
      ]
    })
    expect(
      runtime.verifyOrchestrationCompatibilityCaller(proof, {
        currentRuntimeLaunchSufficient: true
      })
    ).not.toBeNull()
    runtime.onPtyData('pty-test', '\x1b]133;D;0\x07', 100)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller(proof, {
        currentRuntimeLaunchSufficient: true
      })
    ).toBeNull()
  })

  it('refuses an unsafe launcher changed after initial preflight before spawning', async () => {
    const opts = await options()
    settings.agentCmdOverrides = { trae: 'traecli resume' }
    await expect(runtime.createTerminal(`id:${target.scope.id}`, opts)).rejects.toThrow('launcher')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses the captured launcher even if shared settings mutate during async revalidation', async () => {
    const opts = await options()
    const prepare = runtime.prepareOrchestrationTraeWorkspaceWrite.bind(runtime)
    vi.spyOn(runtime, 'prepareOrchestrationTraeWorkspaceWrite').mockImplementation(
      async (...args) => {
        if (settings.agentCmdOverrides) {
          settings.agentCmdOverrides.trae = 'traecli resume'
        }
        return prepare(...args)
      }
    )
    await runtime.createTerminal(`id:${target.scope.id}`, opts)
    const parsed = tokenizeStartupCommand(spawn.mock.calls[0]?.[0].command ?? '', 'posix')
    if (!parsed.ok) {
      throw new Error('Invalid launch command')
    }
    expect(parsed.tokens.slice(0, 2)).toEqual(['traecli', '--no-daemon'])
    expect(spawn.mock.calls[0]?.[0].command).not.toContain('resume')
  })

  const invalidOptions: TerminalCreateOptions[] = [
    { cwd: '/tmp' },
    { agentArgs: '--yolo' },
    { requireFreshPane: false },
    { startupAgent: 'codex' },
    { launchSource: 'terminal' },
    { sessionId: 'old' },
    { shellOverride: 'bash' },
    { envToDelete: ['SANDBOX'] },
    { command: 'traecli resume' },
    { env: { TEST: '1' } }
  ]
  it.each(invalidOptions)('refuses changed launch options %j', async (override) => {
    await expect(
      runtime.createTerminal(`id:${target.scope.id}`, { ...(await options()), ...override })
    ).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['ssh:test', 'runtime:test'] as const)(
    'refuses changed execution ownership %s',
    async (hostId) => {
      const opts = await options()
      if (!target.managedWorktree) {
        throw new Error('Missing managed fixture')
      }
      target.managedWorktree.hostId = hostId
      await expect(runtime.createTerminal(`id:${target.scope.id}`, opts)).rejects.toThrow(
        'local POSIX'
      )
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  it('refuses adoption of an existing pane without spawning or killing it', async () => {
    const opts = await options()
    const release = vi.fn()
    const adoptStablePane = vi
      .fn<NonNullable<RuntimePtyController['adoptStablePane']>>()
      .mockResolvedValue({
        result: { id: 'existing' },
        owner: { ptyId: 'existing', tabId: 'old-tab', leafId: 'old-leaf' }
      })
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      claimStablePaneCreate: () => release,
      adoptStablePane
    })
    await expect(runtime.createTerminal(`id:${target.scope.id}`, opts)).rejects.toThrow(
      'agent_launch_pane_already_live'
    )
    expect(adoptStablePane).toHaveBeenCalledOnce()
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
})
