import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { prepareTraeWorkerWorkspaceWrite } from '../../../../trae-worker-workspace-write'
import type { ResolvedWorktree } from '../../../../runtime-worktree-path-identity'
import type { RuntimeTerminalShow } from '../../../../../../shared/runtime-types'

describe.skipIf(process.platform === 'win32')('worker writable-root RPC forwarding', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  let fixture: string
  let evidence: string
  let workspace: ResolvedWorktree
  let prepared: Awaited<ReturnType<typeof prepareTraeWorkerWorkspaceWrite>>

  beforeEach(async () => {
    state = h.setup()
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'orca-roots-rpc-')))
    evidence = join(fixture, 'evidence')
    const path = join(fixture, 'workspace')
    const homePath = join(fixture, 'home')
    await Promise.all([evidence, path, homePath].map((directory) => mkdir(directory)))
    workspace = {
      id: `repo::${path}`,
      repoId: 'repo',
      path,
      displayName: 'test',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      head: 'abc',
      branch: 'test',
      isBare: false,
      isMainWorktree: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path, head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    }
    prepared = await prepareTraeWorkerWorkspaceWrite({
      platform: 'linux',
      executionHostId: 'local',
      connectionId: null,
      workspacePath: path,
      homePath,
      writableRoots: [evidence]
    })
    const coordinator: RuntimeTerminalShow = {
      handle: 'term_coord',
      ptyId: 'pty_coord',
      worktreeId: workspace.id,
      worktreePath: path,
      branch: 'test',
      tabId: 'tab_coord',
      leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'coordinator',
      connected: true,
      writable: true,
      lastOutputAt: 0,
      preview: '',
      paneRuntimeId: 1,
      rendererGraphEpoch: 1
    }
    const { runtime } = state
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue(coordinator)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(workspace)
    vi.spyOn(runtime, 'prepareOrchestrationTraeWorkspaceWrite').mockResolvedValue(prepared)
    vi.spyOn(runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: workspace.id,
      path,
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    vi.spyOn(runtime, 'resolveProjectRuntimeForWorktree').mockReturnValue(undefined)
    vi.spyOn(runtime, 'createTerminal').mockRejectedValue(new Error('test boundary reached'))
    vi.spyOn(state.db, 'createStartingWorkerDispatch')
  })

  afterEach(async () => {
    h.cleanup()
    vi.restoreAllMocks()
    await rm(fixture, { recursive: true, force: true })
  })

  const start = (overrides: Record<string, unknown> = {}) =>
    h.call(
      'orchestration.workerStart',
      {
        spec: 'test writable roots',
        from: 'term_coord',
        agent: 'trae',
        worktree: 'current',
        writableRoots: [evidence],
        ...overrides
      },
      state.ctx
    )

  it('carries exact roots, fresh-pane constraint, mailbox and receipt through real placement', async () => {
    const result = await start({ model: 'gpt-5.5', effort: 'high', backendVariant: 'max' })
    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'terminal_create',
      lastError: 'test boundary reached',
      residualResources: []
    })
    const { runtime, db } = state
    expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith(`id:${workspace.id}`, {
      materializePushTarget: false
    })
    expect(runtime.showTerminalWorkspaceLaunchScope).toHaveBeenCalledWith(`id:${workspace.id}`)
    expect(runtime.resolveProjectRuntimeForWorktree).toHaveBeenCalledWith(workspace.id)
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      `id:${workspace.id}`,
      expect.objectContaining({
        startupAgent: 'trae',
        launchSource: 'orchestration',
        requireFreshPane: true,
        agentArgs: prepared.agentArgs,
        traeWorkspaceWrite: prepared,
        launchPreferences: { model: 'gpt-5.5', effort: 'high', backendVariant: 'max' },
        startupPrompt: expect.stringContaining(
          'Your complete task is in your durable Dispatch inbox.'
        )
      })
    )
    const { dispatchId } = z.object({ dispatchId: z.string() }).parse(result)
    const dispatch = db.getWorkerDispatch(dispatchId)
    if (!dispatch) {
      throw new Error('Missing dispatch')
    }
    expect(JSON.parse(dispatch.start_options)).toMatchObject({ workspaceWrite: prepared.receipt })
  })

  it.each([
    { terminal: 'term_existing' },
    { agent: 'codex' },
    { worktree: 'new-child', name: 'new' },
    { worktree: 'new-top-level', name: 'new' }
  ])('refuses unsupported placement before dispatch or terminal creation %j', async (override) => {
    await expect(start(override)).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(state.db.createStartingWorkerDispatch).not.toHaveBeenCalled()
    expect(state.runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('leaves no dispatch when execution-host or root preflight refuses', async () => {
    vi.mocked(state.runtime.prepareOrchestrationTraeWorkspaceWrite).mockRejectedValue(
      new Error('unsupported host')
    )
    await expect(start()).rejects.toThrow('unsupported host')
    expect(state.db.createStartingWorkerDispatch).not.toHaveBeenCalled()
    expect(state.runtime.createTerminal).not.toHaveBeenCalled()
  })

  it.each([undefined, 'max', 'ultra'])(
    'refuses GPT-5.4 backend %s before creating resources',
    async (backendVariant) => {
      await expect(
        start({ model: 'gpt-5.4', effort: 'xhigh', backendVariant })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(state.db.createStartingWorkerDispatch).not.toHaveBeenCalled()
      expect(state.runtime.createTerminal).not.toHaveBeenCalled()
      expect(state.runtime.prepareOrchestrationTraeWorkspaceWrite).not.toHaveBeenCalled()
    }
  )
})
