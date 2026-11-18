import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type {
  AgentRowView,
  AgentTokenView,
  DashboardCard,
  ProviderSpend,
  TaskWorkbenchView,
  TaskWorkbenchWorkspace
} from './task-workbench-view'

/**
 * Shared builders for task-workbench-fixtures.ts.
 *
 * Why a sibling module: the twelve scenario entries alone sit close to the .ts
 * `max-lines` budget, and these builders are not part of the fixture contract.
 * Nothing here reads data; the fixtures module is still the only consumer, and
 * this file must not import React, a store or an RPC.
 */

const NOW = 1_767_000_000_000
const MINUTE = 60_000
const GITHUB = { provider: 'github', owner: 'acme', repo: 'web-app' } as const

/** Worktree ids derive from the branch so the default-workspace marker can
 *  point at the same value without a second literal. `worktreeName` defaults to
 *  the branch, but a fixture may pass a display name instead — that is how f1
 *  exercises the rule that a workspace identity names its branch (README §7.4.2
 *  取舍 2), because Orca names a generated worktree after the task title. */
export function workspace(
  repoName: string,
  branchName: string,
  extra: Partial<TaskWorkbenchWorkspace> = {}
): TaskWorkbenchWorkspace {
  return {
    repoId: `repo-${repoName}`,
    worktreeId: `wt-${branchName.replaceAll('/', '-')}`,
    repoName,
    worktreeName: extra.worktreeName ?? branchName,
    branchName,
    hostKind: 'local',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    workspaceKind: 'worktree',
    ...extra
  }
}

export type ViewBody = Omit<
  TaskWorkbenchView,
  'identity' | 'title' | 'tracker' | 'defaultWorkspace' | 'workspaces'
> & { workspaces?: TaskWorkbenchWorkspace[] }

/** Tracker-backed task: identity, tracker, default workspace and the
 *  single-workspace list all derive from the same workspace value. */
export function tracked(
  title: string,
  defaultWorkspace: TaskWorkbenchWorkspace | null,
  state: 'open' | 'closed',
  body: ViewBody
): TaskWorkbenchView {
  return {
    identity: { kind: 'tracker', provider: GITHUB },
    title,
    tracker: { state, url: 'https://github.com/acme/web-app/issues/412' },
    defaultWorkspace: {
      workspaceId: defaultWorkspace?.worktreeId ?? '',
      source: defaultWorkspace ? 'explicit' : 'none'
    },
    workspaces: defaultWorkspace ? [defaultWorkspace] : [],
    ...body
  }
}

export function zeroWorkspace(title: string, state: 'open' | 'closed'): TaskWorkbenchView {
  return tracked(title, null, state, {
    agents: [],
    spend: { kind: 'unavailable', reason: 'no_matching_session' }
  })
}

export type FixtureRowState = 'working' | 'attention' | 'done' | 'idle'

/** `DashboardBucket` has `attention`; `DashboardCardDotState` does not. The
 *  Needs-you bucket therefore names the dot state its row should paint. */
const DOT_STATE = {
  working: 'working',
  attention: 'waiting',
  done: 'done',
  idle: 'idle'
} satisfies Record<FixtureRowState, DashboardCard['dotState']>

/** One agent row. Bucket and dot state follow the lifecycle state, so a row
 *  reads as the state it exercises; only the differences are named. */
export function row(
  key: string,
  agentType: DashboardCard['agentType'],
  state: FixtureRowState,
  task: string,
  tokens: AgentTokenView,
  options: Partial<Pick<AgentRowView, 'outcome'>> & {
    ws?: TaskWorkbenchWorkspace
    subagents?: DashboardCard['subagents']
  } = {}
): AgentRowView {
  const finished = state === 'done' || state === 'idle'
  const ws = options.ws
  return {
    base: {
      paneKey: `pane-${key}`,
      ptyId: `pty-${key}`,
      agentType,
      bucket: state,
      dotState: DOT_STATE[state],
      task,
      repoId: ws?.repoId ?? 'repo-web-app',
      worktreeId: ws?.worktreeId ?? 'wt-feature-add-login',
      tabId: `tab-${key}`,
      leafId: 'leaf-1',
      repoName: ws?.repoName ?? 'web-app',
      worktreeName: ws?.worktreeName ?? 'feature/add-login',
      startedAt: NOW - 12 * MINUTE,
      finishedAt: finished ? NOW - 6 * MINUTE : null,
      stateChangedAt: finished ? NOW - 6 * MINUTE : NOW - 5 * MINUTE,
      unseen: state === 'attention' || state === 'done',
      subagents: options.subagents
    },
    tokens,
    outcome: options.outcome,
    // The pill names the workspace by branch for the same reason the Workspaces
    // section does: the display name is usually the task title (README §7.4.2).
    workspaceLabel: ws ? `${ws.repoName} · ${ws.branchName ?? ws.worktreeName}` : undefined
  }
}

export const rollup = (tokens: number): AgentTokenView => ({ kind: 'rollup', tokens })
export const vault = (tokens: number): AgentTokenView => ({ kind: 'ai-vault', tokens })

export function providerSpend(
  provider: string,
  tokens: number,
  costUsd: number | null
): ProviderSpend {
  return { provider, tokens, costUsd }
}

export function availableSpend(
  tokens: number,
  costUsd: number | null,
  byProvider: ProviderSpend[]
): TaskWorkbenchView['spend'] {
  return { kind: 'available', tokens, costUsd, byProvider, unattributedSessions: 0 }
}

export function deliveryEvidence(
  commits: number,
  [prNumber, prState]: readonly [number, 'draft' | 'open' | 'merged' | 'closed'],
  [passing, total]: readonly [number, number],
  review: 'pending' | 'approved' | 'changes-requested'
): NonNullable<TaskWorkbenchView['delivery']> {
  return {
    commits: { count: commits },
    pullRequest: {
      number: prNumber,
      state: prState,
      title: 'Task workbench fixture',
      url: `https://github.com/acme/web-app/pull/${prNumber}`
    },
    checks: { passing, total },
    review
  }
}

export const WS_LOGIN = workspace('web-app', 'feature/add-login', {
  worktreeName: 'Add login auth'
})
export const WS_API = workspace('api', 'feature/jwt-verify')
export const WS_SPIKE = workspace('web-app', 'investigation/perf-spike')
export const WS_PERF = workspace('orca', 'perf-spike')
export const WS_FLAKY = workspace('web-app', 'fix/flaky-checkout')
export const WS_LEDGER = workspace('api', 'feature/usage-ledger')
export const WS_ARCHIVED = workspace('web-app', 'feature/retire-export', { archived: true })
export const WS_REMOTE = workspace('api', 'feature/audit-backfill', {
  hostKind: 'ssh',
  executionHostId: 'ssh:build-box'
})
export const SUB_JWT = { id: 'sub-jwt', name: 'jwt-verify', dotState: 'working' } as const
export const REMOTE_TOKENS: AgentTokenView = { kind: 'unavailable', reason: 'remote_host' }

export const TWO_AGENTS = [
  row('a1', 'claude', 'working', 'Wire JWT middleware', rollup(412_000)),
  row('a2', 'codex', 'done', 'Verify the signing path', vault(890_000))
]

export const LEDGER_AGENTS = [
  row('l1', 'claude', 'working', 'Reconcile the ledger', rollup(45_000)),
  row('l2', 'codex', 'done', 'Audit the session window', vault(120_000))
]
