// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageComposerActionsModel } from '@/components/use-task-page-composer-actions'
import type * as NewWorkspaceModule from '@/lib/new-workspace'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import { useAppStore } from '@/store'
import { useTaskPageDockActions } from './use-task-page-dock-actions'

// Why: this sparse cone omits orca/resources; the store chain reaches pet-models, which imports
// those assets with `?url`. The rendered harness stubs the same module.
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
const repo: Repo = {
  id: 'repo-1',
  path: '/repo/checkout',
  displayName: 'widgets',
  badgeColor: '#123456',
  addedAt: 1,
  projectGroupId: 'group-1',
  upstream: { owner: 'acme', repo: 'widgets' }
}
const group = {
  id: 'group-1',
  name: 'web',
  parentPath: '/repo/checkout',
  parentGroupId: null,
  createdFrom: 'manual' as const,
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  connectionId: null
}
const createdWorkspace = {
  id: 'draft-1',
  projectGroupId: 'group-1',
  name: 'Add Retry Button',
  folderPath: '/users/me/Orca/task-drafts/key-1',
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

function settings(): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only these fields.
  return {
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    terminalWindowsShell: ''
  } as unknown as GlobalSettings
}

function createModel(): TaskPageComposerActionsModel {
  const model = { taskSource: 'github', primaryRepo: repo, folderWorkspaces: [] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the source, repo and folder fields.
  return model as unknown as TaskPageComposerActionsModel
}

type Hook = { result: { current: ReturnType<typeof useTaskPageDockActions> } }

async function submit(hook: Hook, instruction: string, model?: string): Promise<void> {
  act(() => {
    hook.result.current.taskDock.onInstructionChange(instruction)
    if (model !== undefined) {
      hook.result.current.taskDock.onModelChange(model)
    }
  })
  await act(async () => {
    hook.result.current.taskDock.onSubmit()
    for (let index = 0; index < 40; index += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  getTaskDraftDirectory.mockImplementation(async ({ draftKey }: { draftKey: string }) => {
    return `/users/me/Orca/task-drafts/${draftKey}`
  })
  createFolderWorkspace.mockResolvedValue(createdWorkspace)
  mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  mocks.ensureAgentStartupInTerminal.mockResolvedValue(undefined)
  mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
  useAppStore.setState({
    settings: settings(),
    detectedAgentIds: ['claude'],
    projectGroups: [group],
    createFolderWorkspace,
    updateFolderWorkspace: vi.fn()
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { app: { getTaskDraftDirectory }, fs: {}, runtime: { call: vi.fn() } }
  })
})

afterEach(() => {
  useAppStore.setState({ projectGroups: [], createFolderWorkspace: undefined })
})

describe('useTaskPageDockActions', () => {
  it('creates one taskDraft workspace with the explicit scratch path and the derived name', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, 'Add a retry button to the login page')

    expect(createFolderWorkspace).toHaveBeenCalledTimes(1)
    const [params] = createFolderWorkspace.mock.calls[0]
    expect(params).toMatchObject({ projectGroupId: 'group-1', taskDraft: true })
    expect(params.folderPath).toMatch(/^\/users\/me\/Orca\/task-drafts\//)
    expect(params.name.length).toBeGreaterThan(0)
    expect(hook.result.current.taskDock.errorMessage).toBeNull()
  })

  it('never falls back to the project group parent path', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, 'Add a retry button')
    const [params] = createFolderWorkspace.mock.calls[0]
    expect(params.folderPath).not.toBe(group.parentPath)
  })

  it('launches one agent in the draft with the instruction and reports the draft it made', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, 'Add a retry button', 'opus')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledTimes(1)
    const startup = JSON.stringify(mocks.ensureAgentStartupInTerminal.mock.calls[0][0])
    expect(startup).toContain('--model')
    expect(startup).toContain('opus')
  })

  it('sends a second instruction to the same session instead of creating another draft', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, 'Add a retry button')
    await submit(hook, 'Also cover the SSO login page')

    expect(createFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledTimes(1)
    expect(mocks.deliverLaunchPromptToAgentTab.mock.calls[0][0].content).toContain('SSO')
  })

  it('calls no tracker write itself: the agent owns creation', async () => {
    const call = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { app: { getTaskDraftDirectory }, fs: {}, runtime: { call } }
    })
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, 'Add a retry button')
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the instruction and shows the failure when the create fails', async () => {
    createFolderWorkspace.mockResolvedValue(null)
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, 'Add a retry button')

    expect(hook.result.current.taskDock.errorMessage).toContain('Could not create')
    expect(hook.result.current.taskDock.instruction).toBe('Add a retry button')
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('refuses a remote group without touching the scratch directory', async () => {
    useAppStore.setState({ projectGroups: [{ ...group, connectionId: 'conn-1' }] })
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, 'Add a retry button')

    expect(hook.result.current.taskDock.errorMessage).toContain('local repository')
    expect(getTaskDraftDirectory).not.toHaveBeenCalled()
    expect(createFolderWorkspace).not.toHaveBeenCalled()
  })
})
