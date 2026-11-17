import type {
  DashboardBucket,
  DashboardCard,
  DashboardCardReview,
  DashboardWorkspace
} from '../../../../shared/dashboard-snapshot'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'

/**
 * The presentational input of the P1a workbench shell (p1a-ui-shell-plan.md §2.1).
 *
 * Why it looks like this:
 * - Nothing here reads data. P1b's identity / join / usage selectors build these
 *   values; the components only render them, so no store, RPC or IPC import may
 *   ever appear in this module or in its consumers.
 * - `tokens` is never a bare number. The source (usage rollup vs AI Vault) and
 *   its availability travel with the count, so wiring the second source in P1b
 *   cannot change the type a row renders (R17).
 * - `defaultWorkspace.source` is explicit because projection has no primary
 *   yet: "recent activity" must never masquerade as a user choice.
 * - Everything stays renderer-local. A shape is promoted into `shared/` only
 *   when it enters the popout, or mobile / wire (R18); this shell does neither.
 */

/** The only additive field over the snapshot shape (R17): `DashboardWorkspace`
 *  has no lifecycle flag, so archived state rides here. P1b fills it; P1a
 *  fixtures hard-code it. Archived workspaces never join Active or Needs you. */
export type TaskWorkbenchWorkspace = DashboardWorkspace & { archived?: boolean }

/** Reasons a token or cost figure is absent. These tokens are the copy of
 *  record: the Spend status text prints them verbatim (README §7.5), so never
 *  read an absent figure as `0`. */
export type SpendReason =
  | 'disabled'
  | 'unpriced'
  | 'ambiguous_session'
  | 'no_matching_session'
  | 'remote_host'
  | 'unattributed'

/** One provider's slice of task spend. `costUsd: null` means unpriced, which the
 *  UI prints as an em dash, never as `$0`. */
export type ProviderSpend = { provider: string; tokens: number; costUsd: number | null }

export type SpendView =
  | {
      kind: 'available'
      tokens: number
      /** Null when any contributing model is unpriced: the total is unknown, not zero. */
      costUsd: number | null
      byProvider: ProviderSpend[]
      unattributedSessions: number
    }
  | { kind: 'unavailable'; reason: SpendReason }

/** Per-agent usage. `rollup` is the usage scan's worktree-scoped total, `ai-vault`
 *  a retained session's own total (its `caveat` says which), and `unavailable`
 *  carries the reason instead of a number. */
export type AgentTokenView =
  | { kind: 'rollup'; tokens: number }
  | { kind: 'ai-vault'; tokens: number; caveat?: string }
  | { kind: 'unavailable'; reason: SpendReason }

/** A finished turn's verdict. `failure` and `cancellation` are never delivered. */
export type AgentOutcome = 'success' | 'failure' | 'cancellation'

/** Renderer overlay on the untouched snapshot card (R18): the row component
 *  adds the workspace pill, the token chip and the outcome mark. */
export type AgentRowView = {
  base: DashboardCard
  tokens: AgentTokenView
  outcome?: AgentOutcome
  /** The row's status reports a session boundary (D12: a boundary is not a
   *  completed turn). Additive and renderer-local: `DashboardCard` carries no
   *  such fact, and the F8 overlay owns the boundary presentation. */
  sessionBoundary?: boolean
  /** Set when the task spans more than one workspace; the row must then say which. */
  workspaceLabel?: string
}

/** Read-only delivery evidence. Absent values stay absent: an empty `commits`
 *  count is not "delivered", and `checks` missing is not "all checks passed". */
export type DeliveryEvidence = {
  commits: { count: number; lastSubject?: string }
  pullRequest?: {
    number: number
    state: 'draft' | 'open' | 'merged' | 'closed'
    title: string
    url: string
  }
  checks?: { passing: number; total: number }
  review?: 'pending' | 'approved' | 'changes-requested'
}

export type TaskWorkbenchView = {
  /** Tracker identity when the task is bound to one; otherwise the workspace's
   *  own worktree id, which renders the "no tracker" badge instead of a provider. */
  identity:
    | { kind: 'tracker'; provider: TaskProviderIdentity }
    | { kind: 'workspace'; primaryWorktreeId: string }
  title: string
  tracker?: { state: 'open' | 'closed'; url: string }
  defaultWorkspace: { workspaceId: string; source: 'explicit' | 'recent-activity' | 'none' }
  /** Merged bucket order is the projection's job; the panel renders what it gets. */
  agents: AgentRowView[]
  workspaces: TaskWorkbenchWorkspace[]
  spend: SpendView
  /** Whole Delivery section degrades to a read-only notice when this is absent. */
  delivery?: DeliveryEvidence
}

// Why: components import every view type from one module, so they never reach
// into `shared/` twice. Re-export only — these shapes stay defined upstream.
export type { DashboardBucket, DashboardCard, DashboardCardReview }

// Why: the layout input/output live next to the pure decision function, but every
// consumer that needs them already imports this module for the view types. One
// import site keeps a component from depending on the module graph. No cycle:
// `task-workbench-layout.ts` imports nothing.
export type { TaskWorkbenchLayout, TaskWorkbenchLayoutInput } from './task-workbench-layout'
