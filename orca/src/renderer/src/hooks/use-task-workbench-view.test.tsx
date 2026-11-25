// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'

import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard, DashboardSnapshot } from '../../../shared/dashboard-snapshot'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { TaskRecord } from '../../../shared/task-records-types'
import type { Worktree } from '../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

/**
 * The tab's assembly, not the selectors' rules: a detail page states which item
 * it is, and this hook must hand that item to the selectors so an issue that
 * never ran anything shows nothing instead of the repo's other branches
 * (issue #38).
 *
 * The dashboard snapshot is mocked for the same reason the list hook's test
 * mocks it: it is the store's own agent pipeline, covered where it lives. What
 * this file pins is which worktrees the view was built from.
 */

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

/** The snapshot the hook asks for, plus the calls it made. Pinned so an
 *  archived task's request (`includeArchivedWorktreeIds`) is observable: the
 *  rows alone cannot prove the hook asked for them (issue #38 review S3). */
const snapshotState = vi.hoisted(() => ({
  current: { generatedAt: 0, cards: [] } as DashboardSnapshot
}))
const snapshotCalls = vi.hoisted(() => [] as unknown[])
vi.mock('@/components/dashboard/useLiveDashboardSnapshot', () => ({
  useLiveDashboardSnapshot: (args?: unknown) => {
    snapshotCalls.push(args)
    return snapshotState.current
  }
}))

import { useAppStore } from '@/store'
import { TaskWorkbenchPanel } from '@/components/task-workbench/TaskWorkbenchPanel'
import type { TaskWorkbenchLayout } from '@/components/task-workbench/task-workbench-view'
import { makeTab, makeWorktree } from '@/store/slices/store-test-helpers'
import { useTaskWorkbenchView } from './use-task-workbench-view'

const REPO_ID = 'repo-1'
const EMPTY_LAYOUT: TaskWorkbenchLayout = {
  columns: 'single',
  delivery: 'collapsed',
  agentHistory: 'expanded',
  spend: 'summary',
  workspaces: 'empty'
}

/** The page's own tracker context: one repo, no item number — exactly what the
 *  detail page hands over, and the shape that used to match the whole repo. */
const GITHUB_WEB_APP: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'local',
  providerIdentity: { provider: 'github', owner: 'acme', repo: 'web-app' }
}

function seed(worktrees: Worktree[]): void {
  useAppStore.setState({ repos: [], worktreesByRepo: { [REPO_ID]: worktrees } })
}

function issueWorktree(id: string, issue: number, extra: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id,
    repoId: REPO_ID,
    linkedIssue: issue,
    // What creating a workspace from the item records: the repo-level tracker
    // context is the provenance the buggy matching read as "this task".
    linkedTaskSourceContext: GITHUB_WEB_APP,
    ...extra
  })
}

function card(worktreeId: string, paneKey: string): DashboardCard {
  return {
    paneKey,
    ptyId: null,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'do the thing',
    repoId: REPO_ID,
    worktreeId,
    tabId: 'tab-1',
    leafId: null,
    repoName: 'acme/web-app',
    worktreeName: worktreeId,
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false
  }
}

/** The persisted record of a deleted workspace for this item (issue #36). */
function deletedRecord(worktreeId: string): TaskRecord {
  return {
    taskId: 'task:github:repo-1:issue:9',
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 9 },
    bindings: [
      {
        worktreeId,
        repoId: REPO_ID,
        hostId: 'local',
        path: '/tmp/gone',
        isArchived: false,
        boundAt: 1,
        boundBy: 'created',
        lastVerifiedAt: null,
        sessions: []
      }
    ],
    intent: {},
    createdAt: 1,
    updatedAt: 2,
    schemaVersion: 1
  }
}

function view(args: {
  number: number
  itemType?: 'issue' | 'pr'
  tracker?: { state: 'open' | 'closed'; url: string }
}) {
  const itemType = args.itemType ?? 'issue'
  return renderHook(() =>
    useTaskWorkbenchView({
      repoId: REPO_ID,
      number: args.number,
      itemType,
      title: `#${args.number}`,
      ...(args.tracker ? { tracker: args.tracker } : {}),
      taskSourceContext: GITHUB_WEB_APP
    })
  ).result.current
}

beforeEach(() => {
  snapshotState.current = { generatedAt: 0, cards: [] }
  snapshotCalls.length = 0
  window.api = undefined as never
})

describe('useTaskWorkbenchView — item scope', () => {
  it('shows zero workspaces for an item that never had one', () => {
    // Three branches of the same repo, none of them #9. The repo-level identity
    // matched all three; the item must match none.
    seed([issueWorktree('wt-1', 1), issueWorktree('wt-2', 2), issueWorktree('wt-3', 3)])

    const current = view({ number: 9 })

    expect(current?.workspaces).toEqual([])
    expect(current?.agents).toEqual([])
    expect(current?.identity).toMatchObject({
      kind: 'tracker',
      item: { type: 'issue', number: 9 }
    })
  })

  it('renders the local empty state when an empty catalog settled without hydrating', async () => {
    useAppStore.setState({
      repos: [
        {
          id: REPO_ID,
          path: '/local/repo',
          displayName: 'web-app',
          badgeColor: 'gray',
          addedAt: 1,
          gitRemoteIdentity: {
            canonicalKey: 'github.com/acme/web-app',
            remoteName: 'origin',
            remoteUrl: 'git@github.com:acme/web-app.git'
          }
        }
      ],
      worktreesByRepo: { [REPO_ID]: [] },
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: false,
      runtimeEnvironmentCatalogSettled: true,
      runtimeStatusByEnvironmentId: new Map()
    })
    window.api = { taskRecords: { get: async () => ({ record: null }) } } as never

    function LocalEmptyPanel(): React.JSX.Element | null {
      const current = useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: GITHUB_WEB_APP
      })
      return current ? <TaskWorkbenchPanel view={current} layout={EMPTY_LAYOUT} /> : null
    }

    const rendered = render(<LocalEmptyPanel />)

    await waitFor(() =>
      expect(screen.getByTestId('task-workbench-empty-state')).toBeInTheDocument()
    )
    rendered.unmount()
  })

  it('reads a remote-childless page through the repo id returned by that runtime', async () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: { [REPO_ID]: [] },
      runtimeEnvironments: [
        {
          id: 'env-a',
          name: 'Build box',
          createdAt: 1,
          updatedAt: 1,
          pairingRevision: 1,
          lastUsedAt: null,
          runtimeId: 'runtime-a',
          endpoints: [
            { id: 'endpoint-a', kind: 'websocket', label: 'Build box', endpoint: 'ws://host' }
          ],
          preferredEndpointId: 'endpoint-a'
        }
      ],
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironmentCatalogSettled: true,
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-a',
          {
            status: {
              runtimeId: 'runtime-a',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              capabilities: ['taskRecords.v1']
            },
            checkedAt: 1
          }
        ]
      ])
    })
    const runtimeCall = vi.fn((request: { method: string; params?: { repoId?: string } }) => {
      const { method } = request
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'runtime-a',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : method === 'repo.list'
            ? {
                repos: [
                  {
                    id: REPO_ID,
                    path: '/remote/repo',
                    displayName: 'web-app',
                    badgeColor: 'gray',
                    addedAt: 1,
                    gitRemoteIdentity: {
                      canonicalKey: 'github.com/acme/web-app',
                      remoteName: 'origin',
                      remoteUrl: 'git@github.com:acme/web-app.git'
                    }
                  }
                ]
              }
            : { record: null, repoKnown: true }
      return Promise.resolve({ id: method, ok: true, result, _meta: { runtimeId: 'runtime-a' } })
    })
    window.api = {
      taskRecords: { get: async () => ({ record: null }) },
      runtimeEnvironments: { call: runtimeCall }
    } as never

    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: GITHUB_WEB_APP
      })
    )

    await waitFor(() => expect(current.result.current?.recordSource?.answered).toEqual(['env-a']))
    expect(current.result.current?.history?.trace).toBe('none')
    expect(
      runtimeCall.mock.calls.find((call) => call[0].method === 'taskRecords.get')?.[0].params?.repoId
    ).toBe(REPO_ID)
  })

  it('shows only the workspaces of the item it names', () => {
    seed([issueWorktree('wt-1', 1), issueWorktree('wt-2', 2)])

    expect(view({ number: 1 })?.workspaces.map((workspace) => workspace.worktreeId)).toEqual([
      'wt-1'
    ])
  })

  it('does not answer an issue with the PR of the same number', () => {
    seed([
      makeWorktree({
        id: 'wt-pr-7',
        repoId: REPO_ID,
        linkedPR: 7,
        linkedTaskSourceContext: GITHUB_WEB_APP
      })
    ])

    expect(view({ number: 7 })?.workspaces).toEqual([])
    expect(view({ number: 7, itemType: 'pr' })?.workspaces).toHaveLength(1)
  })

  it('keeps an archived workspace of the item visible as history (issue #31)', () => {
    seed([issueWorktree('wt-9', 9, { isArchived: true })])
    snapshotState.current = { generatedAt: 0, cards: [card('wt-9', 'pane-9')] }

    const current = view({ number: 9 })
    expect(current?.workspaces.map((workspace) => workspace.worktreeId)).toEqual(['wt-9'])
    expect(current?.workspaces[0]?.archived).toBe(true)
    // The archived row is history, never Working, however its card reads.
    expect(current?.agents.map((row) => row.archivedWorkspace)).toEqual([true])
    expect(current?.defaultWorkspace).toEqual({ workspaceId: '', source: 'none' })
    // The hook must ask the snapshot for this task's archived rows; the rows
    // alone cannot prove it did.
    expect(snapshotCalls.at(-1)).toEqual({ includeArchivedWorktreeIds: ['wt-9'] })
  })

  it('does not carry another item’s agent rows into this item', () => {
    // The card belongs to #1's workspace; #9 has none, so the view must not show
    // a row for it even though the repo does have a running agent.
    seed([issueWorktree('wt-1', 1)])
    snapshotState.current = { generatedAt: 0, cards: [card('wt-1', 'pane-1')] }

    expect(view({ number: 9 })?.agents).toEqual([])
    expect(view({ number: 9 })?.workspaces).toEqual([])
    expect(view({ number: 1 })?.agents).toHaveLength(1)
  })

  it('never borrows the repo’s first live worktree when the page names an item', () => {
    // No provider identity on the page, so the identity selector has only
    // provenance to go on — and the repo's branch is still not this item.
    seed([issueWorktree('wt-1', 1)])
    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: null
      })
    ).result.current

    expect(current).toBeNull()
  })

  it('states a deleted workspace’s history without a provider identity (issue #38 review)', async () => {
    // The page knows the item and the repo but carries no provider identity, so
    // no worktree of #9 is left to name it: the run ledger is the only proof it
    // ran. The tab must state that, not the never-started notice — and it must
    // not borrow #1's workspace (or its agent) to get there.
    seed([issueWorktree('wt-1', 1)])
    snapshotState.current = { generatedAt: 0, cards: [card('wt-1', 'pane-1')] }
    window.api = {
      taskRecords: { get: async () => ({ record: deletedRecord('repo-1::/gone') }) }
    } as never

    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: null
      })
    )

    await waitFor(() => expect(current.result.current).not.toBeNull())
    expect(current.result.current?.workspaces).toEqual([])
    expect(current.result.current?.agents).toEqual([])
    expect(current.result.current?.defaultWorkspace).toEqual({ workspaceId: '', source: 'none' })
    expect(current.result.current?.history).toMatchObject({
      trace: 'deleted',
      deletedWorkspaces: 1,
      // The record stores the mapping and whatever it settled, not the runs:
      // unknown, never 0. No usage figure was frozen for this binding, so the
      // state says the build captured none — it must not claim a scan ran and
      // found nothing (`no_matching_session`).
      agents: null,
      wall: { kind: 'unknown' },
      tokens: { kind: 'unknown' }
    })
    expect(current.result.current?.spend).toMatchObject({ kind: 'unavailable' })
  })

  it('never reuses the previous item’s ledger while a new query is in flight', async () => {
    // Switching #9 -> #10: the old ledger answer is still in state until the
    // effect runs, and using it would name #10 with #9's deleted workspace
    // (issue #38 review R1). #10 has no provider identity and no workspace, so
    // the only correct answer before the new answer arrives is "no identity".
    seed([issueWorktree('wt-1', 1)])
    let releaseNext: ((value: { record: TaskRecord | null }) => void) | null = null
    window.api = {
      taskRecords: {
        get: (query: { number: number }) =>
          query.number === 9
            ? Promise.resolve({ record: deletedRecord('repo-1::/gone') })
            : new Promise((resolve) => {
                releaseNext = resolve
              })
      }
    } as never

    const renders: { number: number; view: ReturnType<typeof useTaskWorkbenchView> }[] = []
    const { rerender } = renderHook(
      (props: { number: number }) => {
        const view = useTaskWorkbenchView({
          repoId: REPO_ID,
          number: props.number,
          itemType: 'issue',
          title: `#${props.number}`,
          taskSourceContext: null
        })
        renders.push({ number: props.number, view })
        return view
      },
      { initialProps: { number: 9 } }
    )
    await waitFor(() =>
      expect(
        renders.some((entry) => entry.number === 9 && entry.view?.history?.trace === 'deleted')
      ).toBe(true)
    )

    rerender({ number: 10 })
    // Every render of #10 must be identity-less: the old ledger answer is still
    // in state until the effect runs, and the effect's own renders are flushed
    // inside `act`, so a per-render assertion is the only way to see the first
    // one (#9's deleted record must not name #10).
    const numberTenViews = renders.filter((entry) => entry.number === 10).map((entry) => entry.view)
    expect(numberTenViews.length).toBeGreaterThan(0)
    expect(numberTenViews.every((view) => view === null)).toBe(true)

    await act(async () => {
      releaseNext?.({ record: null })
    })
    expect(
      renders.filter((entry) => entry.number === 10).every((entry) => entry.view === null)
    ).toBe(true)
  })

  it('keeps the never-started notice when the ledger has nothing for the item', async () => {
    seed([issueWorktree('wt-1', 1)])
    let release: ((value: { record: TaskRecord | null }) => void) | null = null
    window.api = {
      taskRecords: {
        get: () =>
          new Promise((resolve) => {
            release = resolve
          })
      }
    } as never

    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: null
      })
    )

    // Pending is not an identity, and neither is an empty answer.
    expect(current.result.current).toBeNull()
    await act(async () => {
      release?.({ record: null })
    })
    expect(current.result.current).toBeNull()
  })

  it('asks the ledger with the page’s provider, so another tracker’s record cannot answer', async () => {
    // Issue #36 review B3: the query key, effect and bridge must carry the
    // provider; a provider-less query is answered by the shared suffix scan,
    // which can hand this page a colliding number from another tracker.
    seed([issueWorktree('wt-1', 9)])
    const get = vi.fn(async () => ({ record: null }))
    window.api = { taskRecords: { get } } as never

    renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: GITHUB_WEB_APP
      })
    )

    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(get).toHaveBeenCalledWith({
      repoId: REPO_ID,
      itemType: 'issue',
      number: 9,
      provider: 'github'
    })
  })
})

describe('useTaskWorkbenchView — delivery eligibility facts', () => {
  it('carries the store’s isMainWorktree flag onto each workspace', () => {
    // §7.11.3 rule 7 / A9: the delivery projection needs the existing store
    // fact to skip the repository's own checkout. The hook is where the view is
    // assembled, so this pins that the fact travels (no new store read).
    seed([
      makeWorktree({
        id: 'repo-1::/repo',
        repoId: REPO_ID,
        branch: 'refs/heads/trunk',
        isMainWorktree: true,
        linkedIssue: 9,
        linkedTaskSourceContext: GITHUB_WEB_APP
      }),
      issueWorktree('wt-9', 9)
    ])

    const current = view({ number: 9 })
    const flags = new Map(
      current?.workspaces.map((workspace) => [workspace.worktreeId, workspace.isMainWorktree])
    )
    expect(flags.get('repo-1::/repo')).toBe(true)
    expect(flags.get('wt-9')).toBe(false)
  })
})

describe('useTaskWorkbenchView — delivery target branch default', () => {
  it('fills targetBranchDefault from the repo main worktree branch', () => {
    // The store shape: `Worktree.branch` keeps the ref `git worktree list`
    // reports (`refs/heads/<name>`), and `isMainWorktree` marks the main working
    // tree. The delivery form asks for a branch name, so the ref prefix is not
    // carried into it.
    seed([
      makeWorktree({
        id: 'repo-1::/repo',
        repoId: REPO_ID,
        branch: 'refs/heads/trunk',
        isMainWorktree: true
      }),
      issueWorktree('wt-9', 9, { branch: 'refs/heads/feat/task-431' })
    ])

    const current = view({ number: 9 })

    expect(current?.targetBranchDefault).toBe('trunk')
    // The linked worktree's own branch is a workspace fact, never the default.
    expect(current?.workspaces.map((workspace) => workspace.worktreeId)).toEqual(['wt-9'])
  })

  it('leaves targetBranchDefault absent when the main worktree has no branch', () => {
    // A detached main worktree reports no branch line at all, which the store
    // keeps as ''; unknown is not "main".
    seed([
      makeWorktree({
        id: 'repo-1::/repo',
        repoId: REPO_ID,
        branch: '',
        isMainWorktree: true
      })
    ])

    expect(view({ number: 9 })?.targetBranchDefault).toBeUndefined()
  })
})

describe('useTaskWorkbenchView — delivery evidence (§7.12)', () => {
  function snapshotWorkspace(
    overrides: Partial<NonNullable<DashboardSnapshot['workspaces']>[number]> = {}
  ): NonNullable<DashboardSnapshot['workspaces']>[number] {
    return {
      repoId: REPO_ID,
      worktreeId: 'wt-9',
      repoName: 'acme/web-app',
      worktreeName: 'feat/task-9',
      hostKind: 'local',
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      workspaceKind: 'worktree',
      ...overrides
    }
  }

  it('fills delivery evidence from the workspace’s own review, and only that', () => {
    seed([issueWorktree('wt-9', 9)])
    snapshotState.current = {
      generatedAt: 1,
      cards: [],
      workspaces: [
        snapshotWorkspace({
          workspaceStatusId: 'completed',
          workspaceStatusLabel: 'Done',
          review: { number: 431, state: 'merged' }
        })
      ]
    }

    const current = view({ number: 9 })
    // The one source this renderer has: a PR number and state. No commit count,
    // no checks, no invented `0`.
    expect(current?.delivery).toEqual({ pullRequest: { number: 431, state: 'merged' } })
    expect(current?.delivery?.commits).toBeUndefined()
    const merged = current?.workspaces.find((workspace) => workspace.worktreeId === 'wt-9')
    expect(merged?.review).toEqual({ number: 431, state: 'merged' })
    expect(merged?.workspaceStatusId).toBe('completed')
  })

  it('leaves delivery absent when no workspace carries a review', () => {
    seed([issueWorktree('wt-9', 9)])

    expect(view({ number: 9 })?.delivery).toBeUndefined()
  })
})

describe('useTaskWorkbenchView — an agent whose TUI was closed', () => {
  /** The page's record for a workspace that is still open, with one run the hook
   *  server observed while it ran. */
  function liveRecord(worktreeId: string): TaskRecord {
    return {
      taskId: 'task:github:repo-1:issue:9',
      hostId: 'local',
      origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 9 },
      bindings: [
        {
          worktreeId,
          repoId: REPO_ID,
          hostId: 'local',
          path: '/tmp/wt-9',
          isArchived: false,
          boundAt: 1,
          boundBy: 'created',
          lastVerifiedAt: 2,
          sessions: [],
          runs: [
            {
              key: 'claude|session_id:run-1',
              providerSession: { provider: 'claude', key: 'session_id', id: 'run-1' },
              agentType: 'claude',
              startedAt: 10,
              endedAt: 20,
              source: 'live-observation',
              recordedAt: 20,
              firstSeenAt: 10,
              lastSeenAt: 20
            }
          ]
        }
      ],
      intent: {},
      createdAt: 1,
      updatedAt: 2,
      schemaVersion: 3
    }
  }

  it('lists the run of a closed pane while the workspace is still open', async () => {
    seed([issueWorktree('wt-9', 9)])
    // The pane is gone (its TUI was closed), so the dashboard projects no card at
    // all: before this fold the task page had nothing to show for that agent.
    snapshotState.current = { generatedAt: 0, cards: [] }
    useAppStore.setState({ agentStatusByPaneKey: {}, retainedAgentsByPaneKey: {} })
    // No type assertion: the page only needs this one IPC method, and defining it
    // directly keeps the test free of a cast the code-quality gate has to allow.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { taskRecords: { get: async () => ({ record: liveRecord('wt-9') }) } }
    })

    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: GITHUB_WEB_APP
      })
    )

    await waitFor(() => expect(current.result.current?.history?.runs).toHaveLength(1))
    const run = current.result.current?.history?.runs[0]
    expect(run).toMatchObject({
      key: 'claude|session_id:run-1',
      agentType: 'claude',
      startedAt: 10,
      endedAt: 20,
      fromRecord: true,
      // The checkout is right there, so the row may offer resume.
      resumable: true,
      checkoutPath: '/tmp/wt-9'
    })
    expect(current.result.current?.history?.historySource).toBe('record')
  })

  it('does not print a retained row and the recorded run of one session twice', async () => {
    seed([issueWorktree('wt-9', 9)])
    snapshotState.current = { generatedAt: 0, cards: [card('wt-9', 'pane-9')] }
    // The process exited: the status map no longer holds the pane, and only the
    // retained snapshot speaks for that run. The record kept the same claim, so
    // the dedupe has to read the retained side too.
    useAppStore.setState({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {
        'pane-9': {
          entry: {
            paneKey: 'pane-9',
            state: 'done',
            prompt: '',
            updatedAt: 20,
            stateStartedAt: 20,
            stateHistory: [],
            providerSession: { key: 'session_id', id: 'run-1' }
          },
          worktreeId: 'wt-9',
          tab: makeTab({ id: 'tab-1', worktreeId: 'wt-9' }),
          agentType: 'claude',
          startedAt: 10
        }
      }
    })

    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: GITHUB_WEB_APP
      })
    )

    await waitFor(() => expect(current.result.current?.history?.runs).toHaveLength(1))
    expect(current.result.current?.history?.runs[0]?.fromRecord).not.toBe(true)
    expect(current.result.current?.history?.historySource).toBe('live')
  })
})
