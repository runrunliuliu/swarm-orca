import { taskProviderIdentityCachePart } from '../../../../shared/task-provider-identity'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'
import type {
  AgentOutcome,
  AgentRowView,
  AgentTokenView,
  DeliveryEvidence,
  SpendView,
  TaskWorkbenchHistory,
  TaskWorkbenchWorkspace
} from '@/components/task-workbench/task-workbench-view'

/**
 * The P1b selector contract (README §6.4 "selector 合同", §7.6): the types the
 * identity / join / usage selectors exchange, plus the two key normalizers they
 * must agree on. Frozen by the Coordinator before the selector modules were
 * written, so three parallel Workers could not invent three seams.
 *
 * Why it lives outside `components/task-workbench/`: the shell keeps reading a
 * `view` prop and nothing else, while the selectors and the store-reading hook
 * live outside it (design decision, `p1a-ui-shell-plan.md` §2.1 + R18). This
 * module is pure: no store, RPC, IPC or Electron import, and the import-boundary
 * test lists it with the shell sources for exactly that reason.
 *
 * Reuse over rewrite (development-plan §2): `JoinWorktree` is the renderer's
 * `DashboardWorkspace` plus the lifecycle and activity facts the view already
 * declares, and per-agent rows arrive as the already-projected `DashboardCard`
 * of `buildDashboardSnapshot` / `selectWorktreeAgentRowsCached`. Nothing here
 * re-derives agent rows, bucket counts or usage attribution.
 */

/** The task's item inside its repository: an owner/repo identity names a repo,
 *  not a task (issue #38). `issue` / `pr` is what a detail page knows; GitHub
 *  numbers issues and PRs separately, so the type has to travel with the number. */
export type TaskWorkbenchItem = {
  type: 'issue' | 'pr'
  number: number
}

/** The identity union the view already declares (R17). Kept structurally equal
 *  on purpose: the hook assigns `IdentityResolution.identity` straight into
 *  `TaskWorkbenchView['identity']`, so a drift fails type-checking there. */
export type TaskWorkbenchIdentity =
  | { kind: 'tracker'; provider: TaskProviderIdentity; item?: TaskWorkbenchItem | null }
  | { kind: 'workspace'; primaryWorktreeId: string }

/** The subset of a `Worktree` the identity selector reads. Declared instead of
 *  importing the whole store shape so the selector stays unit-testable. */
export type IdentityWorktree = {
  worktreeId: string
  isArchived: boolean
  /** The number columns GitHub rows carry (`linkedIssue` / `linkedPR` with the
   *  caller's repo is how the list already reserves a workspace for one item). */
  linkedIssue?: number | null
  linkedPR?: number | null
  /** The provider-neutral link record, which is the only evidence for providers
   *  whose rows have no number column (GitLab MRs, Linear, Jira). */
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
}

export type IdentityInput = {
  /** Present when the caller has the task itself (detail page, tracker row). */
  taskSourceContext?: TaskSourceContext | null
  /** The item the caller is looking at. Present means the identity — and its
   *  key — are item-scoped, and the "first worktree is the task" fallback is
   *  off: another branch's workspace is never this item's answer (issue #38). */
  item?: TaskWorkbenchItem | null
  /** Every worktree the caller already filtered to this task's repo/host. */
  worktrees: readonly IdentityWorktree[]
}

export type IdentityResolution = {
  identity: TaskWorkbenchIdentity
  /** Deterministic, never localized, stable across reloads: the grouping key. */
  taskKey: string
  /** How the task key was resolved. `archived-worktree` means the only
   *  provenance left is a workspace the user put away (issue #31): still the
   *  same task, and still worth naming when nothing live is around. */
  source: 'task-source-context' | 'worktree' | 'archived-worktree' | 'workspace-fallback'
}

/**
 * The grouping key. `taskProviderIdentityCachePart` is the existing normalizer
 * for provider identity (`shared/task-provider-identity.ts`), so a worktree row
 * and a detail page produce the same string for the same task.
 *
 * The repo part stays repo-scoped on purpose: it is the identity selector's own
 * cache/normalization seam, and widening it would fork that implementation.
 * The *item* scope is appended here instead — `tracker:github:acme/web-app:issue:412`
 * — because the repo-scoped string alone made every issue of a repo share one
 * key (issue #38). An identity without an item keeps the repo key and is a
 * repo's name, never a task's workspace set.
 *
 * Known limit, recorded rather than hidden: the view's identity union carries
 * no `hostId`, so the key does not encode one beyond what the provider identity
 * already has (a GitHub `host`). Callers already scope worktrees to one host
 * (the store does); M2b must widen the union before a key can span hosts.
 */
export function taskWorkbenchTaskKey(identity: TaskWorkbenchIdentity): string {
  if (identity.kind === 'workspace') {
    return `workspace:${identity.primaryWorktreeId}`
  }
  const cachePart = taskProviderIdentityCachePart(identity.provider)
  const repoKey = `tracker:${identity.provider.provider}:${cachePart}`
  const item = identity.item ?? null
  return item ? `${repoKey}:${item.type}:${item.number}` : repoKey
}

/** `*UsageProjectBreakdown` keys are `worktree:<worktreeId>` (the worktree id
 *  itself is `repoId::/path`). One helper so no selector spells the prefix. */
export const WORKTREE_USAGE_KEY_PREFIX = 'worktree:'

export function worktreeUsageKey(worktreeId: string): string {
  return `${WORKTREE_USAGE_KEY_PREFIX}${worktreeId}`
}

export type WorkspaceUsageStatus =
  | 'available'
  | 'disabled'
  | 'remote_host'
  | 'no_matching_session'
  | 'unpriced'

/** One provider's normalized breakdown row. The four providers expose different
 *  row shapes; the caller normalizes tokens/cost into this, and the usage
 *  selector never reads a provider-specific total again. */
export type UsageBreakdownRow = {
  key: string
  label: string
  tokens: number
  /** Null means unpriced (never zero): the UI prints an em dash. */
  costUsd: number | null
}

export type UsageProviderId = 'claude' | 'codex' | 'opencode' | 'muse'

export type UsageSelectorInput = {
  /** Active (non-archived) worktree ids of this task, in display order. */
  worktreeIds: readonly string[]
  /** `scanState.enabled` for the provider set; false is the `disabled` state. */
  enabled: boolean
  /** True when any matched worktree runs on a non-local execution host. */
  remote: boolean
  /** Per-provider breakdown rows, already narrowed to the keys above. */
  providers: readonly { provider: UsageProviderId; rows: readonly UsageBreakdownRow[] }[]
  /** Session-level attribution for the task's time window, when the caller ran it. */
  attribution?: { kind: 'ambiguous' } | { kind: 'none' } | null
  /** Sessions the attribution could not place on any worktree. */
  unattributedSessions?: number
  /** Per-agent retained-session attribution, when the caller resolved it.
   *  A worktree rollup cannot be split per agent, so this is the only source of
   *  a per-agent number; an absent entry stays unavailable, never a share. */
  agents?: readonly { paneKey: string; session?: { tokens: number; caveat?: string } }[]
}

export type WorkspaceUsage = {
  worktreeId: string
  /** `available`/`unpriced` carry numbers; every other status carries nulls. */
  status: WorkspaceUsageStatus
  /** Null when unknown (disabled, remote, or no matching key). Never 0. */
  tokens: number | null
  /** Null when unknown or unpriced; `unpriced` still has `tokens`. Never 0. */
  costUsd: number | null
  byProvider: readonly { provider: UsageProviderId; tokens: number; costUsd: number | null }[]
}

export type UsageSelectorResult = {
  /** Task-level view the panel renders. Unknown is never rendered as 0 or $0. */
  spend: SpendView
  /** Workspace-level totals; the `projectBreakdown` litmus compares against these. */
  workspaces: readonly WorkspaceUsage[]
  /** Per-row token view keyed by paneKey. A missing key means `unavailable`
   *  with reason `unattributed` — the caller must not invent a share. */
  agentTokens: Readonly<Record<string, AgentTokenView>>
}

/** One agent row as the join selector receives it: the projected card plus the
 *  facts a `DashboardCard` cannot carry (verdict, boundary, attribution). */
export type JoinAgentInput = {
  card: DashboardCard
  /** Main-agent verdict from `AgentStatusEntry`, when the store knew one. */
  outcome?: AgentOutcome
  /** The row's status reports a session boundary (D12: not Delivered). */
  sessionBoundary?: boolean
  /** From `UsageSelectorResult.agentTokens`; omitted stays unavailable. */
  tokens?: AgentTokenView
}

/** `DashboardWorkspace` + lifecycle + the activity signal the default-workspace
 *  rule needs. `archived` is derived by the join selector, never passed here. */
export type JoinWorktree = Omit<TaskWorkbenchWorkspace, 'archived'> & {
  isArchived: boolean
  /** Newest activity the caller can prove (status/terminal timestamp). */
  lastActivityAt?: number
}

export type JoinInput = {
  identity: IdentityResolution
  /** Every worktree of this task, active and archived, in display order. */
  worktrees: readonly JoinWorktree[]
  /** Rows per worktreeId, already projected. Archived worktrees contribute
   *  marked history rows only: they never enter Working or Needs you. */
  agentsByWorktree: Readonly<Record<string, readonly JoinAgentInput[]>>
  /** Per-worktree delivery evidence; the join merges, it does not derive. */
  deliveryByWorktree?: Readonly<Record<string, DeliveryEvidence | undefined>>
  /** Persistence-backed primary; absent until M2b, so join reports
   *  `recent-activity` or `none` and never claims an explicit user choice. */
  primaryWorktreeId?: string
}

export type JoinResult = {
  /** Active workspaces first, archived last; `archived` rides the view type. */
  workspaces: TaskWorkbenchWorkspace[]
  activeWorktreeIds: string[]
  archivedWorktreeIds: string[]
  /** Active and archived rows. An archived row carries `archivedWorkspace`, so
   *  it lands in History and cannot contribute Working / Needs you. */
  agents: AgentRowView[]
  /** Bucket counts for the layout input, computed from `agents`. Archived rows
   *  count as history only, never as active or attention. */
  counts: { agents: number; activeAgents: number; attentionAgents: number; historyAgents: number }
  delivery?: DeliveryEvidence
  defaultWorkspace: { workspaceId: string; source: 'explicit' | 'recent-activity' | 'none' }
  /** What the task can still say about work it already ran (issue #31). Active
   *  and archived rows both feed it; a deleted workspace cannot, so the join
   *  reports the archived state and the caller may set the deleted one. */
  history: TaskWorkbenchHistory
}
