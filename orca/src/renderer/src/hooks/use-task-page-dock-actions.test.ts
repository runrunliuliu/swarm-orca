// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskPageComposerActionsModel } from '@/components/use-task-page-composer-actions'
import type * as NewWorkspaceModule from '@/lib/new-workspace'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskProvider } from '../../../shared/task-providers'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { useTaskPageDockActions, type TaskPageDockActionsModel } from './use-task-page-dock-actions'

const DRAFT_ROOT = '/users/me/Library/Application Support/Orca/task-drafts'
const INSTRUCTION = 'Add a retry button to the login page'
const DERIVED_NAME = 'Add Retry Button Login Page'
const PROPOSAL_TITLE = 'Add a retry button'
const ISSUE_URL = 'https://github.com/acme/widgets/issues/412'

// Why: this checkout's sparse cone omits orca/resources, and the store chain reaches
// components/pet/pet-models.ts, which imports those assets with `?url`. The rendered
// harness stubs the same imports with a transparent pixel; the unit runner has no asset
// loader, so stub the module itself rather than skip the hook's only real test.
vi.mock('@/components/pet/pet-models', () => ({
  DEFAULT_PET_ID: 'claude-the-mage',
  OPENCODE_PET_ID: 'opencode-the-rogue',
  GREMLIN_PET_ID: 'gremlin-the-trickster',
  BUNDLED_PETS: [],
  BUNDLED_PET: { id: 'claude-the-mage', label: 'Probe', url: '' },
  findBundledPet: () => undefined,
  isBundledPetId: () => false
}))

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab
}))
vi.mock('@/lib/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof NewWorkspaceModule>()),
  ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal
}))

const getTaskDraftDirectory = vi.fn()
const createFolderWorkspace = vi.fn()
const updateFolderWorkspace = vi.fn()
const readFile = vi.fn()
const writeFile = vi.fn()
const runtimeCall = vi.fn()
const listWorkItems = vi.fn()
const searchLinearIssues = vi.fn()
const searchJiraIssues = vi.fn()
const preflightCheck = vi.fn()

const repo: Repo = {
  id: 'repo-1',
  path: '/repo/checkout',
  displayName: 'widgets',
  badgeColor: '#123456',
  addedAt: 1,
  projectGroupId: 'group-1',
  upstream: { owner: 'acme', repo: 'widgets' }
}

const group: ProjectGroup = {
  id: 'group-1',
  name: 'web',
  parentPath: '/repo/checkout',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  connectionId: null
}

const createdWorkspace: FolderWorkspace = {
  id: 'draft-1',
  projectGroupId: 'group-1',
  name: DERIVED_NAME,
  folderPath: `${DRAFT_ROOT}/draft-key-1`,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1,
  taskDraft: true
}

function createModel(
  overrides: {
    repo?: Repo | null
    taskSource?: TaskProvider
    extra?: Record<string, unknown>
  } = {}
): TaskPageComposerActionsModel {
  const model = {
    taskSource: overrides.taskSource ?? 'github',
    primaryRepo: overrides.repo === undefined ? repo : overrides.repo,
    folderWorkspaces: [],
    ...overrides.extra
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this hook reads only the task-source, repo, folder and draft-target fields; the other 39-stage fields are irrelevant here.
  return model as unknown as TaskPageComposerActionsModel
}

function createSettings(): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the default-agent and launch-default fields below.
  return {
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    terminalWindowsShell: ''
  } as unknown as GlobalSettings
}

type Hook = { result: { current: TaskPageDockActionsModel } }
type DraftModel = TaskPageDockActionsModel['taskDock']['draft']

async function submit(hook: Hook, instruction: string): Promise<void> {
  act(() => {
    hook.result.current.taskDock.onInstructionChange(instruction)
  })
  await act(async () => {
    hook.result.current.taskDock.onSubmit()
  })
}

/** Flush the hook's promise chain without relying on timers. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 40; index += 1) {
      await Promise.resolve()
    }
  })
}

async function actOnDraft(hook: Hook, action: (draft: DraftModel) => void): Promise<void> {
  await act(async () => {
    action(hook.result.current.taskDock.draft)
  })
  await flush()
}

async function startDraft(hook: Hook): Promise<void> {
  await submit(hook, INSTRUCTION)
  await flush()
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush()
}

function draftKey(): string {
  const call = getTaskDraftDirectory.mock.calls.at(-1)
  return typeof call?.[0].draftKey === 'string' ? call[0].draftKey : ''
}

function proposalJson(
  overrides: {
    revision?: number
    title?: string
    provider?: string
    draftKey?: string
    repoId?: string | null
    proposal?: unknown
  } = {}
): string {
  return JSON.stringify({
    version: 1,
    draftKey: overrides.draftKey ?? draftKey(),
    attempt: 1,
    provider: overrides.provider ?? 'github',
    repoId: overrides.repoId === undefined ? repo.id : overrides.repoId,
    revision: overrides.revision ?? 1,
    proposal: overrides.proposal ?? {
      title: overrides.title ?? PROPOSAL_TITLE,
      body: 'Body',
      labels: ['bug']
    }
  })
}

function serveProposal(content: string): void {
  readFile.mockImplementation(async ({ filePath }: { filePath: string }) => {
    if (filePath.endsWith('task-draft-proposal.json')) {
      return { content, isBinary: false }
    }
    throw new Error('ENOENT')
  })
}

/** Submit once, then poll the proposal into `preview-ready`. */
async function reachPreview(
  hook: Hook,
  overrides: Parameters<typeof proposalJson>[0] = {}
): Promise<void> {
  // Why: the initial poll tick must not read a proposal left behind by an earlier hook in this test.
  readFile.mockRejectedValue(new Error('ENOENT'))
  await startDraft(hook)
  serveProposal(proposalJson(overrides))
  await advance(1_500)
  expect(hook.result.current.taskDock.draft.state).toBe('preview-ready')
}

const originalState = useAppStore.getState()

beforeEach(() => {
  vi.resetAllMocks()
  getTaskDraftDirectory.mockImplementation(async ({ draftKey }: { draftKey: string }) => {
    return `${DRAFT_ROOT}/${draftKey}`
  })
  createFolderWorkspace.mockResolvedValue(createdWorkspace)
  updateFolderWorkspace.mockResolvedValue(true)
  readFile.mockRejectedValue(new Error('ENOENT'))
  writeFile.mockResolvedValue(undefined)
  runtimeCall.mockResolvedValue({
    ok: true,
    result: { ok: true, number: 412, url: ISSUE_URL }
  })
  listWorkItems.mockResolvedValue({ items: [] })
  searchLinearIssues.mockResolvedValue([])
  searchJiraIssues.mockResolvedValue([])
  preflightCheck.mockResolvedValue({
    git: { installed: true },
    gh: { installed: true, authenticated: true }
  })
  mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  mocks.ensureAgentStartupInTerminal.mockResolvedValue(undefined)
  mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
  useAppStore.setState({
    settings: createSettings(),
    detectedAgentIds: ['claude'],
    projectGroups: [group],
    createFolderWorkspace,
    updateFolderWorkspace
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: { getTaskDraftDirectory },
      fs: { readFile, writeFile },
      runtime: { call: runtimeCall },
      gh: { listWorkItems },
      linear: { searchIssues: searchLinearIssues },
      jira: { searchIssues: searchJiraIssues },
      preflight: { check: preflightCheck }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState({
    settings: originalState.settings,
    detectedAgentIds: originalState.detectedAgentIds,
    projectGroups: originalState.projectGroups,
    createFolderWorkspace: originalState.createFolderWorkspace,
    updateFolderWorkspace: originalState.updateFolderWorkspace
  })
})

describe('useTaskPageDockActions', () => {
  it('creates one taskDraft folder workspace with the derived name and the scratch path', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, INSTRUCTION)

    await waitFor(() => expect(createFolderWorkspace).toHaveBeenCalledTimes(1))
    const args = createFolderWorkspace.mock.calls[0][0]
    const key = getTaskDraftDirectory.mock.calls[0][0].draftKey
    expect(args).toEqual({
      projectGroupId: 'group-1',
      name: DERIVED_NAME,
      folderPath: `${DRAFT_ROOT}/${key}`,
      taskDraft: true
    })
  })

  it('never falls back to parentPath and reuses one draft key across a failed retry', async () => {
    createFolderWorkspace.mockRejectedValueOnce(new Error('scratch directory missing'))
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, INSTRUCTION)

    await waitFor(() => expect(createFolderWorkspace).toHaveBeenCalledTimes(1))
    const firstArgs = createFolderWorkspace.mock.calls[0][0]
    expect(firstArgs.folderPath).not.toBe(group.parentPath)
    expect(firstArgs.folderPath.startsWith(`${DRAFT_ROOT}/`)).toBe(true)
    const firstKey = getTaskDraftDirectory.mock.calls[0][0].draftKey
    expect(typeof firstKey).toBe('string')

    await waitFor(() => expect(hook.result.current.taskDock.errorMessage).not.toBeNull())
    await submit(hook, INSTRUCTION)

    await waitFor(() => expect(createFolderWorkspace).toHaveBeenCalledTimes(2))
    expect(createFolderWorkspace.mock.calls[1][0].folderPath).toBe(firstArgs.folderPath)
    expect(getTaskDraftDirectory.mock.calls.map(([args]) => args.draftKey)).toEqual([
      firstKey,
      firstKey
    ])
  })

  it('launches exactly one agent in the created workspace with the instruction', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, INSTRUCTION)

    await waitFor(() => expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledTimes(1))
    const [folderWorkspaceId, options] = mocks.activateAndRevealFolderWorkspace.mock.calls[0]
    expect(folderWorkspaceId).toBe(createdWorkspace.id)
    expect(options.agent).toBe('claude')
    expect(options.startup.command).toContain(INSTRUCTION)

    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.ensureAgentStartupInTerminal.mock.calls[0][0]).toMatchObject({
      worktreeId: folderWorkspaceKey(createdWorkspace.id),
      primaryTabId: 'tab-1'
    })
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
  })

  it('sends a second instruction to the same draft tab without creating another workspace', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, INSTRUCTION)
    await waitFor(() => expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledTimes(1))

    await submit(hook, 'Also cover the SSO login page')

    await waitFor(() => expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledTimes(1))
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      content: 'Also cover the SSO login page',
      submit: true,
      forcePaste: true
    })
    expect(createFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(hook.result.current.taskDock.instruction).toBe(''))
  })

  it('keeps the instruction and the draft when the running session rejects it', async () => {
    mocks.deliverLaunchPromptToAgentTab.mockResolvedValueOnce(false)
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, INSTRUCTION)
    await waitFor(() => expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledTimes(1))

    await submit(hook, 'Also cover the SSO login page')

    await waitFor(() => expect(hook.result.current.taskDock.errorMessage).not.toBeNull())
    expect(hook.result.current.taskDock.instruction).toBe('Also cover the SSO login page')
    expect(createFolderWorkspace).toHaveBeenCalledTimes(1)
  })

  it('sets the error, keeps the text and launches nothing when the create fails', async () => {
    createFolderWorkspace.mockRejectedValueOnce(new Error('scratch directory missing'))
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, INSTRUCTION)

    await waitFor(() =>
      expect(hook.result.current.taskDock.errorMessage).toBe('scratch directory missing')
    )
    expect(hook.result.current.taskDock.instruction).toBe(INSTRUCTION)
    expect(hook.result.current.taskDock.draft.state).toBe('draft-failed')
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
  })

  it('refuses a remote group or a non-local repo host without touching the scratch directory', async () => {
    const remoteRepoHook = renderHook(() =>
      useTaskPageDockActions(createModel({ repo: { ...repo, executionHostId: 'ssh:box' } }))
    )
    await submit(remoteRepoHook, INSTRUCTION)
    await waitFor(() => expect(remoteRepoHook.result.current.taskDock.errorMessage).not.toBeNull())
    expect(remoteRepoHook.result.current.taskDock.draft.state).toBe('remote-unsupported')

    useAppStore.setState({ projectGroups: [{ ...group, connectionId: 'ssh-box' }] })
    const remoteGroupHook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(remoteGroupHook, INSTRUCTION)
    await waitFor(() => expect(remoteGroupHook.result.current.taskDock.errorMessage).not.toBeNull())

    expect(createFolderWorkspace).not.toHaveBeenCalled()
    expect(getTaskDraftDirectory).not.toHaveBeenCalled()
    expect(remoteGroupHook.result.current.taskDock.instruction).toBe(INSTRUCTION)
  })

  it('keeps every tracker write off the draft path', () => {
    const trackerWritePatterns = [
      'linear.issueCreate',
      'github.createIssue',
      'github create-issue',
      'linear create',
      'gh issue create',
      'gh pr create',
      'issueCreate'
    ]
    // Why cwd-relative: this file runs under happy-dom, where `import.meta.url` is not a
    // file URL, so `fileURLToPath` throws. Neighbouring happy-dom tests read sources the
    // same way (components/terminal-pane/terminal-ios-hangul-preedit-coexistence.test.ts).
    const readSource = (relativePath: string): string =>
      readFileSync(join(process.cwd(), relativePath), 'utf8')
    const hookSource = readSource('src/renderer/src/hooks/use-task-page-dock-actions.ts')
    const dockSource = readSource('src/renderer/src/components/task-page/TaskDock.tsx')
    const promptSource = readSource('src/renderer/src/lib/task-draft-prompt.ts')

    const guardedFiles: [string, string][] = [
      ['use-task-page-dock-actions.ts', hookSource],
      ['TaskDock.tsx', dockSource]
    ]
    for (const [file, source] of guardedFiles) {
      for (const pattern of trackerWritePatterns) {
        expect(source, `${file} must not contain "${pattern}"`).not.toContain(pattern)
      }
    }

    // Why: the prompt names these commands only to forbid them, or for the opt-in gh fallback (D8).
    const promptOffenders = promptSource
      .split('\n')
      .filter((line) => trackerWritePatterns.some((pattern) => line.includes(pattern)))
      .filter(
        (line) => !line.includes('do not run') && !line.includes('Only if the app later sends')
      )
    expect(
      promptOffenders,
      `task-draft-prompt.ts may only name tracker writes on its "do not run" or fallback line; patterns: ${trackerWritePatterns.join(', ')}`
    ).toEqual([])
  })

  it('never emits a state the card does not render', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/hooks/use-task-page-dock-actions.ts'),
      'utf8'
    )
    const card = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/task-page/task-draft-preview-card.tsx'),
      'utf8'
    )
    const emitted = new Set([...source.matchAll(/setState\('([a-z-]+)'\)/g)].map((m) => m[1]))
    const rendered = new Set([...card.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]))
    expect(emitted.size).toBeGreaterThan(0)
    // `idle` renders nothing; every other emitted state must have a card branch.
    for (const state of emitted) {
      if (state === 'idle') {
        continue
      }
      expect(rendered, `no card branch for emitted state: ${state}`).toContain(state)
    }
  })
})

describe('useTaskPageDockActions confirmed write', () => {
  it('never calls runtime.call before confirm and exactly once after a double click', async () => {
    vi.useFakeTimers()
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    expect(runtimeCall).not.toHaveBeenCalled()

    act(() => {
      hook.result.current.taskDock.draft.onConfirmCreate()
      hook.result.current.taskDock.draft.onConfirmCreate()
    })
    await flush()
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(hook.result.current.taskDock.draft.state).toBe('creating-issue')

    resolveCreate({ ok: true, result: { ok: true, number: 412, url: ISSUE_URL } })
    await flush()
    expect(hook.result.current.taskDock.draft.state).toBe('idle')
  })

  it('writes the receipt before the link and links the created issue once', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    writeFile.mockImplementation(async () => {
      order.push('receipt')
    })
    updateFolderWorkspace.mockImplementation(async () => {
      order.push('link')
      return true
    })
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    await actOnDraft(hook, (draft) => draft.onConfirmCreate())

    expect(order).toEqual(['receipt', 'link'])
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'github.createIssue',
      params: { repo: 'repo-1', title: PROPOSAL_TITLE, body: 'Body', labels: ['bug'] }
    })
    const filePath = String(writeFile.mock.calls[0][0].filePath)
    const content = String(writeFile.mock.calls[0][0].content)
    expect(filePath.endsWith('task-draft-receipt.json')).toBe(true)
    expect(JSON.parse(content)).toMatchObject({
      version: 1,
      channel: 'primary-rpc',
      provider: 'github',
      number: 412,
      url: ISSUE_URL,
      title: PROPOSAL_TITLE,
      draftKey: draftKey()
    })

    expect(updateFolderWorkspace).toHaveBeenCalledTimes(1)
    const [workspaceId, updates] = updateFolderWorkspace.mock.calls[0]
    expect(workspaceId).toBe(createdWorkspace.id)
    expect(updates.linkedTask).toEqual({
      provider: 'github',
      type: 'issue',
      number: 412,
      title: PROPOSAL_TITLE,
      url: ISSUE_URL,
      repoId: 'repo-1'
    })
    expect(updates.linkedTaskSourceContext).toMatchObject({
      kind: 'task-source',
      provider: 'github',
      projectId: 'group-1',
      hostId: 'local',
      repoId: 'repo-1',
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'widgets' }
    })
    expect(hook.result.current.taskDock.draft.state).toBe('idle')
  })

  it('links a linear issue through linear.issueCreate and keeps its identifier', async () => {
    vi.useFakeTimers()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: {
        issue: {
          identifier: 'ENG-123',
          title: PROPOSAL_TITLE,
          url: 'https://linear.app/acme/issue/ENG-123'
        }
      }
    })
    const hook = renderHook(() =>
      useTaskPageDockActions(
        createModel({
          taskSource: 'linear',
          extra: {
            newLinearIssueTargetTeam: { id: 'team-1', key: 'ENG', workspaceId: 'ws-1' },
            selectedLinearWorkspaceId: 'ws-1'
          }
        })
      )
    )
    await reachPreview(hook, { provider: 'linear' })

    await actOnDraft(hook, (draft) => draft.onConfirmCreate())

    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'linear.issueCreate',
      params: {
        title: PROPOSAL_TITLE,
        body: 'Body',
        teamKey: 'ENG',
        labels: ['bug'],
        workspaceId: 'ws-1'
      }
    })
    const receipt = JSON.parse(String(writeFile.mock.calls[0][0].content))
    expect(receipt).toMatchObject({ provider: 'linear', number: 123, identifier: 'ENG-123' })
    expect(updateFolderWorkspace.mock.calls[0][1].linkedTask).toMatchObject({
      provider: 'linear',
      number: 123,
      linearIdentifier: 'ENG-123'
    })
  })

  it('keeps the receipt and retries only the link when the link write returns false', async () => {
    vi.useFakeTimers()
    updateFolderWorkspace.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    await actOnDraft(hook, (draft) => draft.onConfirmCreate())

    expect(hook.result.current.taskDock.draft.state).toBe('issue-created-link-failed')
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledTimes(1)
    const receiptContent = writeFile.mock.calls[0][0].content

    await actOnDraft(hook, (draft) => draft.onRetry())

    expect(updateFolderWorkspace).toHaveBeenCalledTimes(2)
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writeFile.mock.calls[0][0].content).toBe(receiptContent)
    expect(hook.result.current.taskDock.draft.state).toBe('idle')
  })

  it('surfaces a provider rejection with no link write and no receipt', async () => {
    vi.useFakeTimers()
    runtimeCall.mockResolvedValue({
      ok: false,
      error: { code: 'github_create_failed', message: 'Repository not found' }
    })
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    await actOnDraft(hook, (draft) => draft.onConfirmCreate())

    expect(hook.result.current.taskDock.draft.state).toBe('provider-rejected')
    expect(hook.result.current.taskDock.draft.providerError).toBe('Repository not found')
    expect(updateFolderWorkspace).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('treats a transport throw as unknown, never retrying create', async () => {
    vi.useFakeTimers()
    runtimeCall.mockRejectedValue(new Error('socket closed'))
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    await actOnDraft(hook, (draft) => draft.onConfirmCreate())

    expect(hook.result.current.taskDock.draft.state).toBe('outcome-unknown')
    expect(hook.result.current.taskDock.errorMessage).toContain('Outcome unknown')
    expect(updateFolderWorkspace).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()

    await actOnDraft(hook, (draft) => draft.onRetry())

    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(hook.result.current.taskDock.draft.state).toBe('outcome-unknown')
  })

  it('opens the prefilled Jira form and never calls the provider', async () => {
    vi.useFakeTimers()
    const setNewJiraIssueTitle = vi.fn()
    const setNewJiraIssueBody = vi.fn()
    const setNewJiraIssueOpen = vi.fn()
    const hook = renderHook(() =>
      useTaskPageDockActions(
        createModel({
          taskSource: 'jira',
          extra: { setNewJiraIssueTitle, setNewJiraIssueBody, setNewJiraIssueOpen }
        })
      )
    )
    await reachPreview(hook, { provider: 'jira' })

    await actOnDraft(hook, (draft) => draft.onConfirmCreate())

    expect(setNewJiraIssueTitle).toHaveBeenCalledWith(PROPOSAL_TITLE)
    expect(setNewJiraIssueBody).toHaveBeenCalledWith('Body')
    expect(setNewJiraIssueOpen).toHaveBeenCalledWith(true)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(updateFolderWorkspace).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    expect(hook.result.current.taskDock.draft.state).toBe('preview-ready')
  })

  it('keeps the frozen proposal across cancel and reopens it on retry', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    act(() => hook.result.current.taskDock.draft.onCancelPreview())
    expect(hook.result.current.taskDock.draft.state).toBe('cancelled')
    expect(hook.result.current.taskDock.draft.proposal).toMatchObject({ title: PROPOSAL_TITLE })

    await actOnDraft(hook, (draft) => draft.onRetry())

    expect(hook.result.current.taskDock.draft.state).toBe('preview-ready')
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})

describe('useTaskPageDockActions proposal poll', () => {
  it('waits on a partial envelope, then leaves drafting on a complete one', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await startDraft(hook)
    expect(hook.result.current.taskDock.draft.state).toBe('drafting')

    serveProposal(
      JSON.stringify({
        version: 1,
        draftKey: draftKey(),
        attempt: 1,
        provider: 'github',
        repoId: 'repo-1',
        revision: 1
      })
    )
    await advance(1_500)
    expect(hook.result.current.taskDock.draft.state).toBe('drafting')

    serveProposal(proposalJson())
    await advance(1_500)
    expect(hook.result.current.taskDock.draft.state).toBe('preview-ready')
    expect(hook.result.current.taskDock.draft.proposal).toMatchObject({ title: PROPOSAL_TITLE })
  })

  it('replaces the frozen proposal with a newer revision', async () => {
    vi.useFakeTimers()
    listWorkItems.mockResolvedValue({ items: [] })
    listWorkItems.mockImplementationOnce(() => new Promise(() => {}))
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await startDraft(hook)

    serveProposal(proposalJson({ revision: 1, title: 'First draft' }))
    await advance(1_500)
    expect(hook.result.current.taskDock.draft.state).toBe('drafting')
    expect(hook.result.current.taskDock.draft.proposal).toMatchObject({ title: 'First draft' })

    serveProposal(proposalJson({ revision: 2, title: 'Second draft' }))
    await advance(1_500)
    expect(hook.result.current.taskDock.draft.state).toBe('preview-ready')
    expect(hook.result.current.taskDock.draft.proposal).toMatchObject({ title: 'Second draft' })
  })

  it('crashes the draft at the deadline when the file stays malformed', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await startDraft(hook)
    serveProposal('{"version": 1, "draftKey"')

    await advance(4 * 60 * 1_000)
    expect(hook.result.current.taskDock.draft.state).toBe('drafting')

    await advance(61 * 1_000)
    expect(hook.result.current.taskDock.draft.state).toBe('agent-crashed')
    expect(hook.result.current.taskDock.errorMessage).not.toBeNull()
  })

  it('crashes immediately with the reason when the envelope names another draft', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await startDraft(hook)
    serveProposal(proposalJson({ draftKey: 'other-draft' }))

    await advance(1_500)
    expect(hook.result.current.taskDock.draft.state).toBe('agent-crashed')
    expect(hook.result.current.taskDock.errorMessage).toContain('wrong-draft')
  })
})

describe('useTaskPageDockActions duplicates', () => {
  it('lists same-title candidates and reuses one without a create call', async () => {
    vi.useFakeTimers()
    listWorkItems.mockResolvedValue({
      items: [{ number: 412, title: PROPOSAL_TITLE, url: ISSUE_URL }]
    })
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await startDraft(hook)
    serveProposal(proposalJson())
    await advance(1_500)

    expect(hook.result.current.taskDock.draft.state).toBe('duplicate-suspected')
    expect(hook.result.current.taskDock.draft.duplicates).toEqual([
      { number: 412, title: PROPOSAL_TITLE, url: ISSUE_URL }
    ])

    await actOnDraft(hook, (draft) =>
      draft.onReuseCandidate({ number: 412, title: PROPOSAL_TITLE, url: ISSUE_URL })
    )

    expect(runtimeCall).not.toHaveBeenCalled()
    expect(updateFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(updateFolderWorkspace.mock.calls[0][1].linkedTask).toMatchObject({ number: 412 })
    expect(hook.result.current.taskDock.draft.state).toBe('idle')
  })

  it('creates exactly once from "still create"', async () => {
    vi.useFakeTimers()
    listWorkItems.mockResolvedValue({
      items: [{ number: 412, title: PROPOSAL_TITLE, url: ISSUE_URL }]
    })
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await startDraft(hook)
    serveProposal(proposalJson())
    await advance(1_500)

    await actOnDraft(hook, (draft) => draft.onCreateAnyway())

    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(updateFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(hook.result.current.taskDock.draft.state).toBe('idle')
  })

  it('keeps preview-ready and says the check could not run when the read fails', async () => {
    vi.useFakeTimers()
    listWorkItems.mockRejectedValue(new Error('offline'))
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await startDraft(hook)
    serveProposal(proposalJson())
    await advance(1_500)

    expect(hook.result.current.taskDock.draft.state).toBe('preview-ready')
    expect(hook.result.current.taskDock.draft.duplicateCheckUnavailable).toBe(true)
    expect(hook.result.current.taskDock.draft.duplicates).toEqual([])
  })
})
