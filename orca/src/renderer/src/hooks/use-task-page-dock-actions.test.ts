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
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { useTaskPageDockActions, type TaskPageDockActionsModel } from './use-task-page-dock-actions'

const DRAFT_ROOT = '/users/me/Library/Application Support/Orca/task-drafts'
const INSTRUCTION = 'Add a retry button to the login page'
const DERIVED_NAME = 'Add Retry Button Login Page'

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

function createModel(overrides: { repo?: Repo | null } = {}): TaskPageComposerActionsModel {
  const model = {
    taskSource: 'github',
    primaryRepo: overrides.repo === undefined ? repo : overrides.repo,
    folderWorkspaces: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this hook reads only taskSource/primaryRepo/folderWorkspaces; the other 39-stage fields are irrelevant here.
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

async function submit(hook: Hook, instruction: string): Promise<void> {
  act(() => {
    hook.result.current.taskDock.onInstructionChange(instruction)
  })
  await act(async () => {
    hook.result.current.taskDock.onSubmit()
  })
}

const originalState = useAppStore.getState()

beforeEach(() => {
  vi.resetAllMocks()
  getTaskDraftDirectory.mockImplementation(async ({ draftKey }: { draftKey: string }) => {
    return `${DRAFT_ROOT}/${draftKey}`
  })
  createFolderWorkspace.mockResolvedValue(createdWorkspace)
  mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  mocks.ensureAgentStartupInTerminal.mockResolvedValue(undefined)
  mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
  useAppStore.setState({
    settings: createSettings(),
    detectedAgentIds: ['claude'],
    projectGroups: [group],
    createFolderWorkspace
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { app: { getTaskDraftDirectory } }
  })
})

afterEach(() => {
  useAppStore.setState({
    settings: originalState.settings,
    detectedAgentIds: originalState.detectedAgentIds,
    projectGroups: originalState.projectGroups,
    createFolderWorkspace: originalState.createFolderWorkspace
  })
})

describe('useTaskPageDockActions', () => {
  it('creates one taskDraft folder workspace with the derived name and the scratch path', async () => {
    const hook = renderHook(() => useTaskPageDockActions(createModel()))
    await submit(hook, INSTRUCTION)

    await waitFor(() => expect(createFolderWorkspace).toHaveBeenCalledTimes(1))
    const args = createFolderWorkspace.mock.calls[0][0]
    const draftKey = getTaskDraftDirectory.mock.calls[0][0].draftKey
    expect(args).toEqual({
      projectGroupId: 'group-1',
      name: DERIVED_NAME,
      folderPath: `${DRAFT_ROOT}/${draftKey}`,
      taskDraft: true
    })
    expect('folderPath' in args).toBe(true)
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

    // Why: the prompt names these commands only to forbid them; any other mention is a regression.
    const promptOffenders = promptSource
      .split('\n')
      .filter((line) => trackerWritePatterns.some((pattern) => line.includes(pattern)))
      .filter((line) => !line.includes('do not run'))
    expect(
      promptOffenders,
      `task-draft-prompt.ts may only name tracker writes on its "do not run" line; patterns: ${trackerWritePatterns.join(', ')}`
    ).toEqual([])
  })
})
