// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageComposerActionsModel } from '@/components/use-task-page-composer-actions'
import type * as NewWorkspaceModule from '@/lib/new-workspace'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskProvider } from '../../../shared/task-providers'
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

describe('useTaskPageDockActions gh fallback', () => {
  it('refuses a non-local draft without a create call or agent delivery', async () => {
    vi.useFakeTimers()
    const model = createModel()
    const hook = renderHook(
      (props: { model: TaskPageComposerActionsModel }) => useTaskPageDockActions(props.model),
      { initialProps: { model } }
    )
    await reachPreview(hook)

    hook.rerender({ model: createModel({ repo: { ...repo, executionHostId: 'ssh:box' } }) })
    await actOnDraft(hook, (draft) => draft.onChooseGhFallback())

    expect(hook.result.current.taskDock.draft.state).toBe('remote-unsupported')
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
  })

  it('refuses a missing or logged-out gh without a create call or agent delivery', async () => {
    vi.useFakeTimers()
    const missing = renderHook(() => useTaskPageDockActions(createModel()))
    preflightCheck.mockResolvedValue({
      git: { installed: true },
      gh: { installed: false, authenticated: false }
    })
    await reachPreview(missing)
    await act(async () => {
      missing.result.current.taskDock.draft.onChooseGhFallback()
    })
    await flush()
    expect(missing.result.current.taskDock.draft.state).toBe('remote-unsupported')
    expect(missing.result.current.taskDock.errorMessage).toContain('not installed')

    const loggedOut = renderHook(() => useTaskPageDockActions(createModel()))
    preflightCheck.mockResolvedValue({
      git: { installed: true },
      gh: { installed: true, authenticated: false }
    })
    await reachPreview(loggedOut)
    await act(async () => {
      loggedOut.result.current.taskDock.draft.onChooseGhFallback()
    })
    await flush()
    expect(loggedOut.result.current.taskDock.draft.state).toBe('remote-unsupported')
    expect(loggedOut.result.current.taskDock.errorMessage).toContain('not signed in')

    expect(runtimeCall).not.toHaveBeenCalled()
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
  })

  it('delivers exactly one --repo/--title command and links the receipt', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    await actOnDraft(hook, (draft) => draft.onChooseGhFallback())

    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledTimes(1)
    const content = String(mocks.deliverLaunchPromptToAgentTab.mock.calls[0][0].content)
    expect(content).toContain('--repo acme/widgets')
    expect(content).toContain('--title')
    expect(content).toContain(PROPOSAL_TITLE)
    expect(hook.result.current.taskDock.draft.state).toBe('creating-issue')

    readFile.mockImplementation(async ({ filePath }: { filePath: string }) => {
      if (filePath.endsWith('task-draft-receipt.json')) {
        return {
          content: JSON.stringify({
            version: 1,
            channel: 'gh-fallback',
            provider: 'github',
            number: 412,
            url: ISSUE_URL,
            title: PROPOSAL_TITLE,
            draftKey: draftKey()
          }),
          isBinary: false
        }
      }
      return { content: proposalJson(), isBinary: false }
    })
    await advance(1_500)
    expect(updateFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(updateFolderWorkspace.mock.calls[0][1].linkedTask).toMatchObject({ number: 412 })
    expect(hook.result.current.taskDock.draft.state).toBe('idle')
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('surfaces an unknown outcome when the fallback receipt never arrives', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)
    readFile.mockImplementation(async ({ filePath }: { filePath: string }) => {
      if (filePath.endsWith('task-draft-receipt.json')) {
        throw new Error('ENOENT')
      }
      return { content: proposalJson(), isBinary: false }
    })

    await actOnDraft(hook, (draft) => draft.onChooseGhFallback())
    expect(hook.result.current.taskDock.draft.state).toBe('creating-issue')

    await advance(61 * 1_000)
    expect(hook.result.current.taskDock.draft.state).toBe('issue-created-link-failed')
    expect(hook.result.current.taskDock.errorMessage).toContain('Outcome unknown')
    expect(updateFolderWorkspace).not.toHaveBeenCalled()
  })
})

describe('review regressions', () => {
  it('treats a returned linear_write_unconfirmed as unknown and never creates again', async () => {
    vi.useFakeTimers()
    runtimeCall.mockResolvedValue({
      ok: false,
      error: { code: 'linear_write_unconfirmed', message: 'The write may have landed.' }
    })
    const hook = renderHook(() => useTaskPageDockActions(createModel({ taskSource: 'linear' })))
    await reachPreview(hook, { provider: 'linear' })

    await actOnDraft(hook, (draft) => draft.onConfirmCreate())

    expect(hook.result.current.taskDock.draft.state).toBe('outcome-unknown')
    expect(hook.result.current.taskDock.errorMessage).toContain('Outcome unknown')
    expect(updateFolderWorkspace).not.toHaveBeenCalled()

    await actOnDraft(hook, (draft) => draft.onRetry())

    // Why: the provider may have created it. A second call is how a duplicate happens.
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(hook.result.current.taskDock.draft.state).toBe('outcome-unknown')
  })

  it('keeps a follow-up in drafting until the agent writes a newer revision', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    await submit(hook, 'Also cover the SSO login page')

    // The previous revision is still on disk; it must not be offered for confirmation again.
    await advance(1_500)
    expect(hook.result.current.taskDock.draft.state).toBe('drafting')

    serveProposal(proposalJson({ revision: 2, title: 'Second draft' }))
    await advance(1_500)

    expect(hook.result.current.taskDock.draft.state).toBe('preview-ready')
    expect(hook.result.current.taskDock.draft.proposal).toMatchObject({ title: 'Second draft' })
  })

  it('opens a new draft for the instruction after the previous one is linked', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)
    await actOnDraft(hook, (draft) => draft.onConfirmCreate())
    expect(hook.result.current.taskDock.draft.state).toBe('idle')

    await submit(hook, 'Second task: add logout')

    expect(createFolderWorkspace).toHaveBeenCalledTimes(2)
    const keys = getTaskDraftDirectory.mock.calls.map((call) => call[0].draftKey as string)
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })

  it('delivers one gh command for a double click, and none while the primary write runs', async () => {
    vi.useFakeTimers()
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(hook)

    await act(async () => {
      hook.result.current.taskDock.draft.onChooseGhFallback()
      hook.result.current.taskDock.draft.onChooseGhFallback()
    })
    await flush()
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledTimes(1)

    // A second draft, with the primary write still in flight: the fallback must stand down.
    mocks.deliverLaunchPromptToAgentTab.mockClear()
    runtimeCall.mockImplementation(() => new Promise(() => {}))
    const pending = renderHook(() => useTaskPageDockActions(createModel()))
    await reachPreview(pending)
    await act(async () => {
      pending.result.current.taskDock.draft.onConfirmCreate()
      pending.result.current.taskDock.draft.onChooseGhFallback()
    })
    await flush()
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
  })
})
