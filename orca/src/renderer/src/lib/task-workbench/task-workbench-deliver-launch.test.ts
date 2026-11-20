import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { workspaceSessionStateSchema } from '../../../../shared/workspace-session-schema'
import { buildHydratedTabState } from '@/store/slices/tabs-hydration'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import {
  TASK_WORKBENCH_DELIVER_SESSION_LABEL,
  isTaskWorkbenchDeliverSessionName
} from '@/components/task-workbench/task-workbench-deliver-session'
import {
  TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE,
  buildTaskWorkbenchDeliverInstruction,
  findTaskWorkbenchDeliverTabId,
  launchTaskWorkbenchDeliver,
  revealTaskWorkbenchDeliverTab,
  type TaskWorkbenchDeliverInput
} from './task-workbench-deliver-launch'

const mocks = vi.hoisted(() => {
  type MockTab = { id: string; quickCommandLabel?: string | null }
  const store: {
    settings: { defaultTuiAgent: string | null; disabledTuiAgents: string[] }
    detectedAgentIds: string[]
    remoteDetectedAgentIds: Record<string, string[]>
    unifiedTabsByWorktree: Record<string, MockTab[]>
    tabsByWorktree: Record<string, MockTab[]>
  } = {
    settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
    detectedAgentIds: [],
    remoteDetectedAgentIds: {},
    unifiedTabsByWorktree: {},
    tabsByWorktree: {}
  }
  return {
    store,
    activateAndRevealWorktree: vi.fn(),
    activateTabAndFocusPane: vi.fn(),
    getConnectionId: vi.fn(),
    launchAgentInNewTab: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

const WORKTREE_ID = 'repo-1::/work/tree'

function deliverInput(
  overrides: Partial<TaskWorkbenchDeliverInput> = {}
): TaskWorkbenchDeliverInput {
  return {
    worktreeId: WORKTREE_ID,
    targetBranch: 'main',
    integrationMode: 'pr',
    archiveAfter: false,
    source: 'task_page',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.settings = { defaultTuiAgent: null, disabledTuiAgents: [] }
  mocks.store.detectedAgentIds = []
  mocks.store.remoteDetectedAgentIds = {}
  mocks.store.unifiedTabsByWorktree = {}
  mocks.store.tabsByWorktree = {}
  mocks.getConnectionId.mockReturnValue(null)
  mocks.activateAndRevealWorktree.mockReturnValue(true)
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'tab-new' }
  })
})

describe('buildTaskWorkbenchDeliverInstruction', () => {
  it('carries the three inputs and the archive-by-human rule', () => {
    const text = buildTaskWorkbenchDeliverInstruction(
      deliverInput({ integrationMode: 'local-merge', archiveAfter: false })
    )
    expect(text).toContain(`Workspace: ${WORKTREE_ID}`)
    expect(text).toContain('Target branch: main')
    expect(text).toContain('local-merge')
    expect(text).toContain('swarm/skills/worktree-delivery/SKILL.md')
    expect(text).toContain('independent review')
    expect(text).toContain('Never write the primary checkout')
    expect(text).toContain('stop and report that instead')
    expect(text).toContain('Do not archive, remove, stop terminals or delete anything')
    expect(text).toContain('A human clicks Archive as the last step')
    // The checkbox only adds a reminder; without it the instruction must not
    // claim the operator asked for an archive.
    expect(text).not.toContain('asked to archive this workspace')
  })

  // K3: the PR requirement is not the default mode's privilege. Every mode must
  // name it, because a direct push of the target branch satisfies "remote" but
  // is not the delivery contract (README §7.11.3 rule 7).
  it.each(['pr', 'local-merge', 'squash'] as const)(
    'requires a pull request against the target branch in %s mode',
    (integrationMode) => {
      const text = buildTaskWorkbenchDeliverInstruction(deliverInput({ integrationMode }))

      expect(text).toContain('Integrate only through a pull request against the target branch')
      expect(text).toContain('This is unconditional in every integration mode')
      expect(text).toContain('never push the target branch directly')
      // The mode is still named, and its own line points at the PR, so the agent
      // never reads the mode as "integrate some other way".
      expect(text).toContain(`Integration mode: ${integrationMode} (`)
      expect(text).toContain('the PR carries')
      // No mode may offer a non-PR integration path in its own description.
      expect(text).not.toContain('merge into the target branch on this machine')
      expect(text).not.toContain('squash the change into one commit on the target branch')
    }
  )

  it('exports the one frozen no-agent notice both hosts render', () => {
    expect(TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE).toEqual({
      key: 'auto.components.Terminal.5b2c1a9e44',
      fallback: 'No agent CLI detected — install one or pick a default agent in Settings.'
    })
  })

  it('adds the remind-only clause when archiveAfter is set, plus the workspace label', () => {
    const text = buildTaskWorkbenchDeliverInstruction({
      ...deliverInput({ archiveAfter: true, source: 'sidebar', integrationMode: 'squash' }),
      workspaceLabel: 'web-app · feature/add-login'
    })
    expect(text).toContain(`web-app · feature/add-login (${WORKTREE_ID})`)
    expect(text).toContain('squash')
    expect(text).toContain('The operator asked to archive this workspace after delivery')
    expect(text).toContain('Do not archive it yourself; only remind the operator')
  })

  it('states attention facts without turning them into an instruction to act', () => {
    const text = buildTaskWorkbenchDeliverInstruction({
      ...deliverInput(),
      attention: ['2 uncommitted files', '1 unpushed commit']
    })
    expect(text).toContain('Facts from the workbench')
    expect(text).toContain('- 2 uncommitted files')
    expect(text).toContain('- 1 unpushed commit')
  })
})

describe('launchTaskWorkbenchDeliver', () => {
  it('launches exactly once for the target worktree and passes the frozen marker', () => {
    mocks.store.detectedAgentIds = ['claude']
    const result = launchTaskWorkbenchDeliver(deliverInput({ source: 'sidebar' }))

    expect(result).toEqual({ ok: true, tabId: 'tab-new' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(WORKTREE_ID)
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
    const args = mocks.launchAgentInNewTab.mock.calls[0][0]
    expect(args.agent).toBe('claude')
    expect(args.worktreeId).toBe(WORKTREE_ID)
    expect(args.quickCommandLabel).toBe(TASK_WORKBENCH_DELIVER_SESSION_LABEL)
    expect(args.promptDelivery).toBe('submit-after-ready')
    expect(args.launchSource).toBe('sidebar')
    expect(args.prompt).toContain('Target branch: main')
    // No launch into any other workspace.
    for (const [call] of mocks.launchAgentInNewTab.mock.calls) {
      expect(call.worktreeId).toBe(WORKTREE_ID)
    }
  })

  it('returns no-agent without launching when the resolver finds nothing', () => {
    const result = launchTaskWorkbenchDeliver(deliverInput())

    expect(result).toEqual({ ok: false, reason: 'no-agent' })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not launch when a marker tab already exists (zero calls)', () => {
    mocks.store.detectedAgentIds = ['claude']
    mocks.store.unifiedTabsByWorktree[WORKTREE_ID] = [
      { id: 'tab-existing', quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL }
    ]

    expect(launchTaskWorkbenchDeliver(deliverInput())).toEqual({
      ok: false,
      reason: 'already-delivering'
    })
    expect(launchTaskWorkbenchDeliver(deliverInput())).toEqual({
      ok: false,
      reason: 'already-delivering'
    })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('launches exactly once across two activations, because the first publish is synchronous', () => {
    mocks.store.detectedAgentIds = ['claude']
    // Stand-in for createTab: the real launch publishes the marker tab before
    // launchAgentInNewTab returns, which is what makes the second call see it.
    mocks.launchAgentInNewTab.mockImplementation(() => {
      mocks.store.unifiedTabsByWorktree[WORKTREE_ID] = [
        { id: 'tab-new', quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL }
      ]
      return { surface: { kind: 'local-terminal', tabId: 'tab-new' } }
    })

    const first = launchTaskWorkbenchDeliver(deliverInput())
    const second = launchTaskWorkbenchDeliver(deliverInput())

    expect(first).toEqual({ ok: true, tabId: 'tab-new' })
    expect(second).toEqual({ ok: false, reason: 'already-delivering' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
  })

  it('also finds a marker on a legacy terminal row', () => {
    mocks.store.tabsByWorktree[WORKTREE_ID] = [
      { id: 'tab-legacy', quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL }
    ]

    expect(findTaskWorkbenchDeliverTabId(WORKTREE_ID)).toBe('tab-legacy')
    expect(launchTaskWorkbenchDeliver(deliverInput())).toEqual({
      ok: false,
      reason: 'already-delivering'
    })
  })
})

describe('revealTaskWorkbenchDeliverTab', () => {
  it('activates the workspace and the existing marker tab', () => {
    mocks.store.unifiedTabsByWorktree[WORKTREE_ID] = [
      { id: 'tab-existing', quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL }
    ]

    expect(revealTaskWorkbenchDeliverTab(WORKTREE_ID)).toBe(true)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(WORKTREE_ID)
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-existing', null)
  })

  it('does nothing when there is no marker tab', () => {
    expect(revealTaskWorkbenchDeliverTab(WORKTREE_ID)).toBe(false)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })
})

describe('D2 evidence', () => {
  // (a) The label survives the persisted round trip: the tab the launcher writes
  // is serialized as-is, validates against the session schema, and hydration
  // restores it from the same row shape.
  it('(a) quickCommandLabel survives persist, schema parse and hydration', () => {
    const tab: Tab = {
      id: 'tab-deliver',
      entityId: 'tab-deliver',
      groupId: 'group-1',
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      label: 'Terminal 1',
      quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const group: TabGroup = {
      id: 'group-1',
      worktreeId: WORKTREE_ID,
      activeTabId: tab.id,
      tabOrder: [tab.id]
    }
    const persisted = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [tab] },
      groupsByWorktree: { [WORKTREE_ID]: [group] },
      layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: group.id } },
      activeGroupIdByWorktree: { [WORKTREE_ID]: group.id }
    })
    expect(persisted.unifiedTabs?.[WORKTREE_ID]?.[0]?.quickCommandLabel).toBe(
      TASK_WORKBENCH_DELIVER_SESSION_LABEL
    )

    const parsed = workspaceSessionStateSchema.parse({
      activeRepoId: 'repo-1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: tab.id,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...persisted
    })
    const hydrated = buildHydratedTabState(parsed, new Set([WORKTREE_ID]))
    const restored = hydrated.unifiedTabsByWorktree[WORKTREE_ID]?.[0]
    expect(restored?.quickCommandLabel).toBe(TASK_WORKBENCH_DELIVER_SESSION_LABEL)
    expect(isTaskWorkbenchDeliverSessionName(restored?.quickCommandLabel)).toBe(true)
  })

  // (b) The row name the workbench reads resolves the label — no new field. A
  // user rename wins first, which is D2's accepted reopen condition.
  it('(b) the row conversation name resolves the marker, and a rename outranks it', () => {
    const base = {
      // Why no cast: `null` is the honest absent value here, and the widened
      // `string | null` annotation the old assertion carried also widened
      // `aiVaultTitle` past its branded type. The rename case below supplies its
      // own `customTitle` and never mutates this object.
      customTitle: null,
      quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL,
      aiVaultTitle: null,
      generatedTitle: null,
      title: 'Terminal 1',
      defaultTitle: 'Terminal 1'
    }
    expect(getAgentRowConversationName(base, 'claude', true)).toBe(
      TASK_WORKBENCH_DELIVER_SESSION_LABEL
    )
    expect(getAgentRowConversationName({ ...base, customTitle: 'my rename' }, 'claude', true)).toBe(
      'my rename'
    )
  })
})
