import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { DeliveryEvidence } from '../../components/task-workbench/task-workbench-view'
import { joinTaskWorkbench } from './task-workbench-join'
import type {
  IdentityResolution,
  JoinAgentInput,
  JoinInput,
  JoinWorktree
} from './task-workbench-selector-types'

/**
 * Hand-written fixtures: every expectation below is a literal table a reader can
 * check against README §6.4 / §7.2, never a number read back out of
 * `countRowBuckets` (contract rule 7). The shell's `task-workbench-fixtures.ts`
 * is not imported on purpose — it belongs to the harness, and a selector test
 * that leaned on it would stop being able to disagree with it.
 */

const IDENTITY: IdentityResolution = {
  identity: { kind: 'workspace', primaryWorktreeId: 'wt-feature' },
  taskKey: 'workspace:wt-feature',
  source: 'workspace-fallback',
  matchedWorktreeIds: ['wt-feature']
}

type Bucket = DashboardCard['bucket']

/** `DashboardBucket` has `attention`; `DashboardCardDotState` does not, so the
 *  dot state each bucket paints is named here instead of derived. */
const DOT_STATE: Record<Bucket, DashboardCard['dotState']> = {
  attention: 'waiting',
  working: 'working',
  done: 'done',
  idle: 'idle'
}

function worktree(
  worktreeId: string,
  worktreeName: string,
  options: {
    archived?: boolean
    lastActivityAt?: number
    branchName?: string
    workspaceKind?: JoinWorktree['workspaceKind']
  } = {}
): JoinWorktree {
  return {
    repoId: 'repo-web-app',
    worktreeId,
    repoName: 'web-app',
    worktreeName,
    hostKind: 'local',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    workspaceKind: options.workspaceKind ?? 'worktree',
    isArchived: options.archived ?? false,
    // `branchName` is absent unless a case means it: the store leaves it out for
    // a folder workspace and for rows persisted before it existed, and the label
    // rule has to survive both (README §7.4.2 取舍 2).
    ...(options.branchName === undefined ? {} : { branchName: options.branchName }),
    // Absent stays absent: `lastActivityAt` is the "nothing proved yet" signal,
    // so a fixture that means it must not write a number.
    ...(options.lastActivityAt === undefined ? {} : { lastActivityAt: options.lastActivityAt })
  }
}

function card(
  worktreeId: string,
  worktreeName: string,
  paneKey: string,
  bucket: Bucket
): DashboardCard {
  return {
    paneKey,
    ptyId: null,
    agentType: 'claude',
    bucket,
    dotState: DOT_STATE[bucket],
    task: 'wire the join selector',
    repoId: 'repo-web-app',
    worktreeId,
    tabId: `tab-${paneKey}`,
    leafId: null,
    repoName: 'web-app',
    worktreeName,
    startedAt: 1_000,
    finishedAt: bucket === 'done' || bucket === 'idle' ? 2_000 : null,
    stateChangedAt: 2_000,
    unseen: false
  }
}

/** One projected row for `worktree`, with only the facts the join adds named. */
function agent(
  worktree: JoinWorktree,
  paneKey: string,
  bucket: Bucket,
  extra: Partial<Pick<JoinAgentInput, 'outcome' | 'sessionBoundary' | 'tokens'>> = {}
): JoinAgentInput {
  return {
    card: card(worktree.worktreeId, worktree.worktreeName, paneKey, bucket),
    ...extra
  }
}

function makeInput(
  overrides: {
    worktrees?: readonly JoinWorktree[]
    agentsByWorktree?: Readonly<Record<string, readonly JoinAgentInput[]>>
    deliveryByWorktree?: Readonly<Record<string, DeliveryEvidence | undefined>>
    primaryWorktreeId?: string
  } = {}
): JoinInput {
  return {
    identity: IDENTITY,
    worktrees: overrides.worktrees ?? [],
    agentsByWorktree: overrides.agentsByWorktree ?? {},
    deliveryByWorktree: overrides.deliveryByWorktree,
    primaryWorktreeId: overrides.primaryWorktreeId
  }
}

describe('joinTaskWorkbench — no workspace', () => {
  it('returns the empty shape and the literal empty default workspace', () => {
    const result = joinTaskWorkbench(makeInput())

    expect(result).toEqual({
      workspaces: [],
      activeWorktreeIds: [],
      archivedWorktreeIds: [],
      agents: [],
      counts: { agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
      defaultWorkspace: { workspaceId: '', source: 'none' }
    })
    // `''` is a sentinel, not a worktree id: the panel must not open anything.
    expect(result.delivery).toBeUndefined()
  })
})

describe('joinTaskWorkbench — one workspace', () => {
  const feature = worktree('wt-feature', 'feature/add-login')

  function resultOneWorkspace() {
    return joinTaskWorkbench(
      makeInput({
        worktrees: [feature],
        agentsByWorktree: {
          'wt-feature': [
            agent(feature, 'pane-working', 'working', { tokens: { kind: 'rollup', tokens: 1200 } }),
            agent(feature, 'pane-done', 'done', { tokens: { kind: 'ai-vault', tokens: 340 } })
          ]
        }
      })
    )
  }

  it('copies the worktree into a workspace without the join-only facts', () => {
    expect(resultOneWorkspace().workspaces).toStrictEqual([
      {
        repoId: 'repo-web-app',
        worktreeId: 'wt-feature',
        repoName: 'web-app',
        worktreeName: 'feature/add-login',
        hostKind: 'local',
        executionHostId: 'local',
        workspaceKind: 'worktree'
      }
    ])
  })

  it('counts the two rows with no workspace label on a single-workspace task', () => {
    const result = resultOneWorkspace()

    // working -> active, done -> history (contract §4.2), written as literals.
    expect(result.counts).toEqual({
      agents: 2,
      activeAgents: 1,
      attentionAgents: 0,
      historyAgents: 1
    })
    expect(result.agents.map((row) => row.base.paneKey)).toEqual(['pane-working', 'pane-done'])
    expect(result.agents.map((row) => row.workspaceLabel)).toEqual([undefined, undefined])
    expect(result.agents[0].tokens).toEqual({ kind: 'rollup', tokens: 1200 })
    expect(result.agents[1].tokens).toEqual({ kind: 'ai-vault', tokens: 340 })
  })
})

describe('joinTaskWorkbench — archived worktrees', () => {
  const one = worktree('wt-one', 'feature/one')
  const parked = worktree('wt-parked', 'feature/parked', { archived: true })
  const two = worktree('wt-two', 'feature/two')

  function resultWithArchive() {
    return joinTaskWorkbench(
      makeInput({
        // The archived worktree sits in the middle of the input on purpose: the
        // selector, not the caller, moves it to the end.
        worktrees: [one, parked, two],
        agentsByWorktree: {
          'wt-one': [agent(one, 'pane-one', 'working')],
          'wt-parked': [agent(parked, 'pane-parked', 'working')],
          'wt-two': [agent(two, 'pane-two', 'attention')]
        }
      })
    )
  }

  it('lists active workspaces first and the archived one last', () => {
    const result = resultWithArchive()

    expect(result.workspaces.map((workspace) => workspace.worktreeId)).toEqual([
      'wt-one',
      'wt-two',
      'wt-parked'
    ])
    expect(result.workspaces[2]).toStrictEqual({
      repoId: 'repo-web-app',
      worktreeId: 'wt-parked',
      repoName: 'web-app',
      worktreeName: 'feature/parked',
      hostKind: 'local',
      executionHostId: 'local',
      workspaceKind: 'worktree',
      archived: true
    })
    // Active entries omit the key rather than writing `archived: false`.
    expect('archived' in result.workspaces[0]).toBe(false)
    expect('archived' in result.workspaces[1]).toBe(false)
    expect(result.activeWorktreeIds).toEqual(['wt-one', 'wt-two'])
    expect(result.archivedWorktreeIds).toEqual(['wt-parked'])
  })

  it('drops archived rows from agents and from every count', () => {
    const result = resultWithArchive()

    expect(result.agents.map((row) => row.base.paneKey)).toEqual(['pane-one', 'pane-two'])
    expect(result.counts).toEqual({
      agents: 2,
      activeAgents: 1,
      attentionAgents: 1,
      historyAgents: 0
    })
    // The label is `repo · branch` now: a bare worktree name is the display name
    // Orca derives from the task title, which repeated the page heading.
    expect(result.agents.map((row) => row.workspaceLabel)).toEqual([
      'web-app · feature/one',
      'web-app · feature/two'
    ])
  })
})

describe('joinTaskWorkbench — one task, many workspaces', () => {
  it('labels every row with its own workspace when several workspaces are live', () => {
    const feature = worktree('wt-feature', 'Add login auth', {
      branchName: 'feature/add-login'
    })
    const fix = worktree('wt-fix', 'fix/login-redirect')

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [feature, fix],
        agentsByWorktree: {
          'wt-feature': [agent(feature, 'pane-feature', 'done')],
          'wt-fix': [agent(fix, 'pane-fix', 'working')]
        }
      })
    )

    // Branch first: the display name above is the task title, which is exactly
    // what a `repo · worktreeName` label would have printed a second time.
    // Second row has no `branchName`, so it falls back to its display name
    // instead of rendering `web-app · undefined`.
    expect(result.agents.map((row) => row.workspaceLabel)).toEqual([
      'web-app · feature/add-login',
      'web-app · fix/login-redirect'
    ])
    expect(result.agents.map((row) => row.base.worktreeId)).toEqual(['wt-feature', 'wt-fix'])
    expect(result.counts).toEqual({
      agents: 2,
      activeAgents: 1,
      attentionAgents: 0,
      historyAgents: 1
    })
  })
})

describe('joinTaskWorkbench — workspace label source', () => {
  it('never invents a branch: a folder workspace keeps its display name', () => {
    // `useTaskWorkbenchView` omits `branchName` for a folder workspace, because
    // its `branch` is a directory path, not a branch. The join must therefore
    // render the display name rather than an empty or path-like label.
    const folder = worktree('wt-folder', 'docs', { workspaceKind: 'folder' })
    const other = worktree('wt-other', 'feature/other')

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [folder, other],
        agentsByWorktree: {
          'wt-folder': [agent(folder, 'pane-folder', 'working')],
          'wt-other': [agent(other, 'pane-other', 'working')]
        }
      })
    )

    expect(result.agents.map((row) => row.workspaceLabel)).toEqual([
      'web-app · docs',
      'web-app · feature/other'
    ])
    expect(result.agents.map((row) => row.workspaceLabel).join(' ')).not.toContain('undefined')
  })
})

describe('joinTaskWorkbench — default workspace', () => {
  it('honours an explicit primary that names a live worktree', () => {
    const first = worktree('wt-first', 'feature/first', { lastActivityAt: 10 })
    const second = worktree('wt-second', 'feature/second', { lastActivityAt: 20 })

    const result = joinTaskWorkbench(
      makeInput({ worktrees: [first, second], primaryWorktreeId: 'wt-first' })
    )

    expect(result.defaultWorkspace).toEqual({ workspaceId: 'wt-first', source: 'explicit' })
  })

  it('ignores a primary that names an archived worktree', () => {
    const first = worktree('wt-first', 'feature/first', { lastActivityAt: 10 })
    const second = worktree('wt-second', 'feature/second', { lastActivityAt: 20 })
    const parked = worktree('wt-parked', 'feature/parked', {
      archived: true,
      lastActivityAt: 30
    })

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [first, second, parked],
        primaryWorktreeId: 'wt-parked'
      })
    )

    // Never "explicit": the user archived that workspace, so the claim is gone.
    expect(result.defaultWorkspace).toEqual({
      workspaceId: 'wt-second',
      source: 'recent-activity'
    })
  })

  it('falls back to the most recent activity when no primary is known', () => {
    const older = worktree('wt-older', 'feature/older', { lastActivityAt: 10 })
    const newer = worktree('wt-newer', 'feature/newer', { lastActivityAt: 20 })

    expect(joinTaskWorkbench(makeInput({ worktrees: [older, newer] })).defaultWorkspace).toEqual({
      workspaceId: 'wt-newer',
      source: 'recent-activity'
    })
  })

  it('keeps the first worktree in input order when activity ties', () => {
    const first = worktree('wt-first', 'feature/first', { lastActivityAt: 7 })
    const second = worktree('wt-second', 'feature/second', { lastActivityAt: 7 })

    expect(joinTaskWorkbench(makeInput({ worktrees: [first, second] })).defaultWorkspace).toEqual({
      workspaceId: 'wt-first',
      source: 'recent-activity'
    })
  })

  it('treats a missing lastActivityAt as least recent, not as epoch', () => {
    const unknown = worktree('wt-unknown', 'feature/unknown')
    const known = worktree('wt-known', 'feature/known', { lastActivityAt: 5 })

    expect(
      joinTaskWorkbench(makeInput({ worktrees: [unknown, known] })).defaultWorkspace
    ).toEqual({ workspaceId: 'wt-known', source: 'recent-activity' })
  })

  it('never names an archived workspace when nothing is live', () => {
    const parked = worktree('wt-parked', 'feature/parked', {
      archived: true,
      lastActivityAt: 30
    })

    expect(
      joinTaskWorkbench(makeInput({ worktrees: [parked], primaryWorktreeId: 'wt-parked' }))
        .defaultWorkspace
    ).toEqual({ workspaceId: '', source: 'none' })
  })
})

describe('joinTaskWorkbench — delivery', () => {
  const DEFAULT_EVIDENCE: DeliveryEvidence = {
    commits: { count: 2, lastSubject: 'wire the join selector' }
  }
  const OTHER_EVIDENCE: DeliveryEvidence = {
    commits: { count: 5, lastSubject: 'polish the panel' },
    checks: { passing: 4, total: 4 }
  }

  it('picks the default workspace evidence even when another workspace has a richer one', () => {
    const first = worktree('wt-first', 'feature/first', { lastActivityAt: 10 })
    const second = worktree('wt-second', 'feature/second', { lastActivityAt: 20 })

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [first, second],
        primaryWorktreeId: 'wt-first',
        deliveryByWorktree: {
          'wt-first': DEFAULT_EVIDENCE,
          'wt-second': OTHER_EVIDENCE
        }
      })
    )

    // One object, never a merge: 2 commits from `wt-first`, not 2 + 5.
    expect(result.delivery).toEqual(DEFAULT_EVIDENCE)
  })

  it('falls back to the first live workspace with evidence when the default has none', () => {
    const first = worktree('wt-first', 'feature/first', { lastActivityAt: 10 })
    const second = worktree('wt-second', 'feature/second', { lastActivityAt: 20 })

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [first, second],
        primaryWorktreeId: 'wt-first',
        deliveryByWorktree: { 'wt-second': OTHER_EVIDENCE }
      })
    )

    expect(result.delivery).toEqual(OTHER_EVIDENCE)
  })

  it('ignores evidence that only archived worktrees report', () => {
    const live = worktree('wt-live', 'feature/live', { lastActivityAt: 10 })
    const parked = worktree('wt-parked', 'feature/parked', { archived: true })

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [live, parked],
        deliveryByWorktree: { 'wt-parked': OTHER_EVIDENCE }
      })
    )

    expect(result.delivery).toBeUndefined()
  })
})

describe('joinTaskWorkbench — row overlay pass-through', () => {
  it('keeps unattributed tokens unavailable instead of writing zero', () => {
    const feature = worktree('wt-feature', 'feature/add-login')

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [feature],
        agentsByWorktree: { 'wt-feature': [agent(feature, 'pane-unknown', 'working')] }
      })
    )

    expect(result.agents[0].tokens).toEqual({ kind: 'unavailable', reason: 'unattributed' })
  })

  it('passes outcome and sessionBoundary through unchanged', () => {
    const feature = worktree('wt-feature', 'feature/add-login')

    const result = joinTaskWorkbench(
      makeInput({
        worktrees: [feature],
        agentsByWorktree: {
          'wt-feature': [
            agent(feature, 'pane-failed', 'done', { outcome: 'failure' }),
            agent(feature, 'pane-boundary', 'done', { sessionBoundary: true }),
            agent(feature, 'pane-plain', 'idle')
          ]
        }
      })
    )

    expect(result.agents[0].outcome).toBe('failure')
    expect(result.agents[0].sessionBoundary).toBeUndefined()
    expect(result.agents[1].sessionBoundary).toBe(true)
    expect(result.agents[1].outcome).toBeUndefined()
    expect(result.agents[2].outcome).toBeUndefined()
    expect(result.agents[2].sessionBoundary).toBeUndefined()
    // All three are `done`/`idle`, so all three sit in history and none of them
    // is counted as active.
    expect(result.counts).toEqual({
      agents: 3,
      activeAgents: 0,
      attentionAgents: 0,
      historyAgents: 3
    })
  })
})
