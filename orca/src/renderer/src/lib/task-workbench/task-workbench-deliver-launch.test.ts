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
  resetTaskWorkbenchDeliverInFlight,
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
    mergePullRequest: true,
    closeIssue: true,
    issueNumber: 42,
    archiveAfter: false,
    source: 'task_page',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTaskWorkbenchDeliverInFlight()
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
  it('carries the three inputs and the archive-by-human rule when the tick is off', () => {
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
    // `<self>` is this instruction's placeholder, not a CLI alias: the agent is
    // told to write out the full workspace id instead of the angle brackets.
    expect(text).toContain('substitute the workspace id printed above in full')
    expect(text).toContain('`id:<repoId>::<path>`')
    expect(text).toContain('never the angle brackets')
    // The tick is what adds the archive step (issue #49); without it the
    // instruction contains no archive command at all.
    expect(text).not.toContain('orca worktree archive')
    expect(text).not.toContain('asked for the archive')
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

  it('adds the archive step after the report when archiveAfter is set, plus the workspace label', () => {
    const text = buildTaskWorkbenchDeliverInstruction({
      ...deliverInput({ archiveAfter: true, source: 'sidebar', integrationMode: 'squash' }),
      workspaceLabel: 'web-app · feature/add-login'
    })
    expect(text).toContain(`web-app · feature/add-login (${WORKTREE_ID})`)
    expect(text).toContain('squash')
    // Issue #49 A1: the tick becomes the agent's own last step, and it is
    // ordered after the report so the report is written (and readable) first.
    expect(text).toContain('orca worktree archive --worktree <self> --json')
    expect(text).toContain('orca worktree unarchive')
    const reportIndex = text.indexOf('Report finished / unfinished / not authorized')
    expect(reportIndex).toBeGreaterThan(-1)
    expect(text.indexOf('orca worktree archive')).toBeGreaterThan(reportIndex)
    // The archive replaces only the archive prohibition: the completed write and
    // the no-cleanup rule stay, and no human-archive sentence contradicts it.
    expect(text).toContain('mark this workspace completed')
    expect(text).toContain('Do not remove, stop terminals or delete anything')
    expect(text).not.toContain('Do not archive, remove, stop terminals')
    // Issue #49 A3: a failed archive is reported, never retried, and never turns
    // the delivery into a failure.
    expect(text).toContain('If the archive fails, say so in the report')
    expect(text).toContain('do not retry it')
    expect(text).toContain('do not treat the delivery as unfinished')
  })

  // §7.12 §5: four authorized stages and their stop conditions. A2/A3/A4 in the
  // plan's acceptance matrix are these three cases and the archive case above.
  it('A2: names the merge when it is authorized, and forbids it when it is not', () => {
    const merged = buildTaskWorkbenchDeliverInstruction(
      deliverInput({ mergePullRequest: true, integrationMode: 'squash' })
    )
    expect(merged).toContain('gh pr merge <number> --squash')
    expect(merged).toContain('verify that the pull request reports `merged`')
    expect(merged).toContain('stop here and report it')

    const notMerged = buildTaskWorkbenchDeliverInstruction(
      deliverInput({ mergePullRequest: false })
    )
    // The prohibition names the command it forbids; what must be absent is the
    // executable merge step, not the sentence saying not to run it.
    expect(notMerged).not.toContain('gh pr merge <number>')
    expect(notMerged).toContain('Do not merge the pull request: merging was not authorized')
    expect(notMerged).toContain('not authorized')
    // The authorized steps still follow: an unticked merge is not a stop for
    // the issue close or the completed write.
    expect(notMerged).toContain('then continue with the authorized steps below')
    expect(notMerged).toContain('gh issue close #42')
    expect(notMerged).toContain('mark this workspace completed')
    // The completion comment states only what was authorized: it must not claim
    // the merge that the operator explicitly did not authorize.
    expect(notMerged).not.toContain('merged as')
    expect(notMerged).toContain('delivered: PR #<number> (merge not authorized)')
  })

  it('A2: an unticked merge plus an unticked close still marks completed, without either claim', () => {
    const text = buildTaskWorkbenchDeliverInstruction(
      deliverInput({ mergePullRequest: false, closeIssue: false })
    )
    expect(text).toContain('Do not merge the pull request')
    expect(text).toContain('Do not close the issue #42')
    expect(text).toContain('mark this workspace completed')
    expect(text).toContain('delivered: PR #<number> (merge not authorized)')
    expect(text).not.toContain('merged as')
    expect(text).not.toContain('issue #42 closed')
  })

  it('A3: names gh issue close with the page number, and never guesses one', () => {
    const withNumber = buildTaskWorkbenchDeliverInstruction(
      deliverInput({ closeIssue: true, issueNumber: 412 })
    )
    expect(withNumber).toContain('gh issue close #412 --comment')
    expect(withNumber).toContain('Closes #412')

    const withoutNumber = buildTaskWorkbenchDeliverInstruction(
      deliverInput({ closeIssue: true, issueNumber: undefined })
    )
    expect(withoutNumber).not.toContain('gh issue close')
    expect(withoutNumber).toContain('this page carries no issue number')

    const notAuthorized = buildTaskWorkbenchDeliverInstruction(
      deliverInput({ closeIssue: false, issueNumber: 412 })
    )
    expect(notAuthorized).not.toContain('gh issue close')
    expect(notAuthorized).toContain('Do not close the issue #412')
    expect(notAuthorized).toContain('not authorized')
  })

  it('A4: includes the archive step only when the tick is set, in any combination of ticks', () => {
    for (const mergePullRequest of [true, false]) {
      for (const closeIssue of [true, false]) {
        for (const archiveAfter of [true, false]) {
          const text = buildTaskWorkbenchDeliverInstruction(
            deliverInput({ mergePullRequest, closeIssue, archiveAfter })
          )
          // The completed write is unconditional.
          expect(text).toContain('mark this workspace completed')
          if (archiveAfter) {
            const reportIndex = text.indexOf('Report finished / unfinished / not authorized')
            expect(reportIndex).toBeGreaterThan(-1)
            expect(text).toContain('orca worktree archive --worktree <self> --json')
            // Report first, archive second — never the other way round.
            expect(text.indexOf('orca worktree archive')).toBeGreaterThan(reportIndex)
            // Never a stop condition, never a delivery verdict.
            expect(text).toContain('do not treat the delivery as unfinished')
          } else {
            expect(text).not.toContain('orca worktree archive')
            expect(text).toContain('Do not archive, remove, stop terminals or delete anything')
            expect(text).toContain('A human clicks Archive as the last step')
          }
        }
      }
    }
  })

  it('A9: always ends on the existing worktree-set write, never a new mechanism', () => {
    const text = buildTaskWorkbenchDeliverInstruction(deliverInput())
    expect(text).toContain('orca worktree set --worktree <self> --workspace-status completed')
    // Archive writes `isArchived`, so the claim is scoped to the completion state.
    expect(text).toContain('This is the only place delivery writes the completion state')
    expect(text).toContain('Never use --force')
    expect(text).toContain('never change branch protection')
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

  it('hands the archive step to the agent exactly when the operator ticked it', () => {
    mocks.store.detectedAgentIds = ['claude']

    launchTaskWorkbenchDeliver(deliverInput({ archiveAfter: true }))
    const ticked = mocks.launchAgentInNewTab.mock.calls[0][0].prompt
    const reportIndex = ticked.indexOf('Report finished / unfinished / not authorized')
    expect(reportIndex).toBeGreaterThan(-1)
    expect(ticked.indexOf('orca worktree archive --worktree <self>')).toBeGreaterThan(reportIndex)

    // The un-ticked launch on the same worktree must carry no archive command.
    launchTaskWorkbenchDeliver(deliverInput({ archiveAfter: false }))
    const unticked = mocks.launchAgentInNewTab.mock.calls[1][0].prompt
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(2)
    expect(unticked).not.toContain('orca worktree archive')
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

  // §7.12 A5, host-published route: the marker lands asynchronously, so a second
  // click in that window must not start a second agent. Local/structured routes
  // publish synchronously and are covered by the marker test above.
  it('launches once for a host-published surface, until its marker can arrive', () => {
    mocks.store.detectedAgentIds = ['claude']
    mocks.launchAgentInNewTab.mockReturnValue({ surface: { kind: 'host-published' } })

    const first = launchTaskWorkbenchDeliver(deliverInput())
    const second = launchTaskWorkbenchDeliver(deliverInput())

    expect(first).toEqual({ ok: true, tabId: '' })
    expect(second).toEqual({ ok: false, reason: 'already-delivering' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
  })

  it('does not keep a local launch blocked once its marker tab exists', () => {
    mocks.store.detectedAgentIds = ['claude']
    mocks.launchAgentInNewTab.mockImplementation(() => {
      mocks.store.unifiedTabsByWorktree[WORKTREE_ID] = [
        { id: 'tab-new', quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL }
      ]
      return { surface: { kind: 'local-terminal', tabId: 'tab-new' } }
    })

    expect(launchTaskWorkbenchDeliver(deliverInput())).toEqual({
      ok: true,
      tabId: 'tab-new'
    })
    // The marker is what refuses the second launch, not a time window.
    expect(launchTaskWorkbenchDeliver(deliverInput())).toEqual({
      ok: false,
      reason: 'already-delivering'
    })
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
