import type {
  DashboardBucket,
  DashboardCard,
  DashboardCardReview,
  DashboardWorkspace
} from '../../../../shared/dashboard-snapshot'
import type { TaskRecordGapKind } from '../../../../shared/task-records-types'
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

/** Additive fields over the snapshot shape (R17): `DashboardWorkspace` carries
 *  neither a lifecycle flag nor a branch, so both ride here. P1b fills them; P1a
 *  fixtures hard-code them. Archived workspaces never join Active or Needs you.
 *
 * `branchName` exists because a workspace identity must name the branch, not the
 * display name: Orca names a generated worktree after the task title, so
 * `repo · worktreeName` would print the page's h1 a second time (README §7.4.2
 * 取舍 2). Optional because a folder workspace and a row persisted before the
 *  field existed both have no branch; the renderer then falls back to
 *  `worktreeName` rather than inventing one. */
export type TaskWorkbenchWorkspace = DashboardWorkspace & {
  archived?: boolean
  branchName?: string
  /** True for the repository's own checkout. It is still listed (a task can be
   *  linked to it), but §7.11.3 rule 7 / A9 forbid delivering there: the
   *  projection never selects it as a target. Optional because a folder
   *  workspace has no worktree at all, and an absent flag is not `false`. */
  isMainWorktree?: boolean
}

/** Reasons a token or cost figure is absent. These tokens stay the vocabulary of
 *  record for diagnostics and tests, but since README §7.4.2 they are no longer
 *  printed as interface copy: the Spend row shows a translated word and keeps the
 *  token in that badge's tooltip. What still holds for every consumer is the rule
 *  they exist for — never read an absent figure as `0`. */
export type SpendReason =
  | 'disabled'
  | 'unpriced'
  | 'ambiguous_session'
  | 'no_matching_session'
  | 'remote_host'
  | 'scan_failed'
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

/** What the writer's own `stat` said about a recorded transcript path (issue
 *  #53). `missing` is only ever a local `stat` that returned ENOENT;
 *  `unverifiable` is a host that could not look at the path at all, so the row
 *  may not call the file gone. Absent means no check was ever stored — which is
 *  not `missing`, for the same reason an absent figure is not `0`. */
export type TaskWorkbenchTraceState = {
  presence: 'present' | 'missing' | 'unverifiable'
  /** When the stored check was taken (ms), so a reader can tell how old an
   *  `unreachable` verdict is. */
  checkedAt: number
}

/** One absence the record observed about a workspace or a run (issue #53 T2).
 *
 *  The kind is the record's own word and stays untranslated as a value:
 *  `session_unattributable` is "nobody could tell which agent ran here" and
 *  `ambiguous_match` is "several candidates, none decided". This type exists so
 *  the panel can say that instead of showing the empty run list, which reads
 *  exactly like "nothing ever ran" — the false negative the issue is about.
 *  `candidateCount` is absent when the observation did not count (a measured `0`
 *  is "looked and found none"), and `detail` is the writer's own reason. */
export type TaskWorkbenchGapView = {
  kind: TaskRecordGapKind
  candidateCount?: number
  detail?: string
  /** True when the workspace this gap belongs to has no run rows at all, so the
   *  sentence is the whole state ("no agent could be attributed here"). False
   *  when rows exist: the gap is then the archive moment's provenance note (no
   *  pane attribution then; the rows were attributed later), and printing it as
   *  "unattributable" over a full list would contradict the list. */
  standalone: boolean
}

/** One run the history strip can list without an Agents section: the deleted
 *  form, where no live or retained row is left to read it from, and the
 *  record-sourced rows an archived workspace's record still states (issue #53).
 *
 * Every fact but `key` is optional because a frozen observation may not have
 * measured it: an absent `startedAt` is unknown, never the epoch, and an absent
 * `title` is a row that prints its claim instead of an invented name. */
export type TaskWorkbenchHistoryRun = {
  /** React list key. For a record-sourced row this IS the claim
   *  (`provider|key:id`) the record merges on; a live row keeps its pane key,
   *  which is runtime state and must never be stored or offered as identity. */
  key: string
  title?: string
  agentType?: DashboardCard['agentType']
  startedAt?: number
  endedAt?: number
  /** Turns the provider counted for the run; absent when nobody counted. */
  messageCount?: number
  outcome?: AgentOutcome
  /** The transcript the record kept for this run, and what its stored `stat`
   *  said about it. A path with no check is a pointer, not a claim of presence. */
  transcriptPath?: string
  trace?: TaskWorkbenchTraceState
  /** False when the checkout that ran this row is gone, so the panel states
   *  that resume is unavailable instead of offering an action that cannot work.
   *  Absent on a live row, where resume is the Agents section's business. */
  resumable?: boolean
  /** The provider's own resume command for this session, as the record stored it
   *  (issue #53 A2). Absent means the observation had none — the hook path never
   *  does — and the row then says so instead of offering an action; it is never a
   *  command this build composed itself. */
  resumeCommand?: string
  /** The checkout the command has to run in (the binding's recorded `path`), so
   *  "resumable" names a directory that really exists. Absent on a row whose
   *  record never stored a path. */
  checkoutPath?: string
  /** True when the row is a frozen observation read from the persisted record,
   *  not a projected live row. The panel renders these rows in the archive form
   *  and says where they came from. */
  fromRecord?: boolean
}

/** How much of the recorded wall clock is actually measured. `partial` carries
 *  the edges that are known; an absent edge stays absent instead of becoming the
 *  epoch or "now", for the same reason `defaultWorkspace.source` is explicit. */
export type TaskWorkbenchWallClock =
  | { kind: 'measured'; startedAt: number; endedAt: number }
  | { kind: 'partial'; startedAt?: number; endedAt?: number }
  | { kind: 'unknown' }

/** Where the recorded trace is. `archived` keeps it on this machine; `deleted`
 *  means the workspace that held it is gone, so the facts survive and the
 *  transcript does not. */
export type TaskWorkbenchHistoryTrace = 'archived' | 'deleted' | 'none'

/** One workspace the history can still name. `removed` means the store has no
 *  row for it any more; it is projected from the persisted binding, never from a
 *  guess, and it must not be offered as an action target. */
export type TaskWorkbenchHistoryWorkspace = {
  worktreeId: string
  path: string
  state: 'archived' | 'removed'
  /** Null = the locator was never confirmed; the row then reads as unresolved. */
  lastVerifiedAt: number | null
  hasSessions: boolean
}

/** One session the removed workspace reported before it went away. `resumable`
 *  is false once the checkout is gone: the id is still useful for finding the
 *  transcript, but a resume into a deleted directory would fail. */
export type TaskWorkbenchHistorySession = {
  /** `<provider key>:<session id>`, never a display string. */
  key: string
  provider?: string
  hasTranscriptPath: boolean
  /** The recorded path itself (the `locate trace` target) and, when the record
   *  stored one, what its `stat` said about it. */
  transcriptPath?: string
  trace?: TaskWorkbenchTraceState
  resumable: boolean
  worktreeId: string
}

/** The facts a closed task can still state about work it already ran (issue
 *  #31). Absent is never zero: `agents: null` and an unavailable token figure
 *  say "not known", which is what a pruned record actually means. */
export type TaskWorkbenchHistory = {
  /** `null` = unknown, never "never ran": a record can survive without rows. */
  agents: number | null
  wall: TaskWorkbenchWallClock
  /** Same "unknown is not zero" rule as a row, but a task-level total rather
   *  than one agent's: only `available` carries a whole number. The four states
   *  are the settlement's own (see `aggregateSettlement`): `available` = every
   *  contributing figure was measured; `partial` = some closed workspaces settled
   *  a number and at least one did not, so `tokens` is a subtotal and the copy
   *  says so; `unavailable` = a workspace was measured and the figure is missing;
   *  `unknown` = no closed workspace was captured at all (this build did not
   *  measure), which is not a reason for a missing figure and never `0`. */
  tokens:
    | { kind: 'available'; tokens: number }
    | { kind: 'partial'; tokens: number }
    | { kind: 'unavailable'; reason: SpendReason }
    | { kind: 'unknown' }
  lastActivityAt?: number
  archivedWorkspaces: number
  deletedWorkspaces: number
  /** `settled` means at least one contributing figure is a settlement snapshot
   *  written before a workspace became unreadable, not a live rollup. */
  tokensSource: 'live' | 'settled'
  /** Archived and removed workspaces this record can still name. */
  workspaces: TaskWorkbenchHistoryWorkspace[]
  /** Sessions of removed workspaces only: live sessions are the Agents section,
   *  and an archived workspace keeps its own rows. */
  sessions: TaskWorkbenchHistorySession[]
  trace: TaskWorkbenchHistoryTrace
  /** The deleted form renders this list as the whole record; the archived form
   *  renders only the record-sourced rows (`fromRecord`), because its live rows
   *  already appear in Agents. */
  runs: TaskWorkbenchHistoryRun[]
  /** Where the run rows came from (issue #53). `record` means at least one row
   *  is a frozen observation the persisted record supplied because no live row
   *  could state it; absent means the live projection, which is what a view
   *  built before this field existed carries. `mixed` means the list holds both
   *  kinds, so no single badge may claim the whole list for the record (S7). */
  historySource?: 'live' | 'record' | 'mixed'
  /** Absences the record observed for this task's archived and removed
   *  workspaces (or for one of their runs). Empty when the record observed none;
   *  a reader must not read an empty list as "nothing ran", which is why the run
   *  list says `no run recorded` separately. */
  gaps?: TaskWorkbenchGapView[]
}

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
  /** The row belongs to an archived workspace, so it is history whatever its
   *  live bucket says: it never contributes Working or Needs you. */
  archivedWorkspace?: boolean
}

/** Read-only delivery evidence. Absent values stay absent: a missing `commits`
 *  entry is "no commit source", which is not a count of zero (README §7.5), a
 *  missing `checks` entry is not "all checks passed", and a PR fact without a
 *  title/url still states its number and state instead of inventing a link.
 *  Since §7.12 the one wired source is the workspace's own `review` (number +
 *  state), so `title` / `url` are genuinely optional: no git or PR query runs
 *  here, and an absent field stays absent rather than becoming an empty string. */
export type DeliveryEvidence = {
  commits?: { count: number; lastSubject?: string }
  pullRequest?: {
    number: number
    state: 'draft' | 'open' | 'merged' | 'closed'
    title?: string
    url?: string
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
  /** The page's tracker state. `number` is optional because a view built without
   *  the page's item (the sidebar, a fixture) has no authority to name one; the
   *  delivery projection prints the issue fact only when it is present, and it
   *  is never guessed from a URL or a PR number (§7.12 A3). */
  tracker?: { state: 'open' | 'closed'; url: string; number?: number }
  defaultWorkspace: { workspaceId: string; source: 'explicit' | 'recent-activity' | 'none' }
  /** Merged bucket order is the projection's job; the panel renders what it gets. */
  agents: AgentRowView[]
  workspaces: TaskWorkbenchWorkspace[]
  spend: SpendView
  /** Whole Delivery section degrades to a read-only notice when this is absent. */
  delivery?: DeliveryEvidence
  /** Present only when work was actually recorded: absent is the never-started
   *  state whose primary action is `Create workspace`. */
  history?: TaskWorkbenchHistory
  /** True until the persisted run ledger answered; the panel must not render the
   *  never-started empty state while a deleted history may still arrive. */
  historyPending?: boolean
  /** The repository's main worktree branch, used only to pre-fill the delivery
   *  confirm's target branch (README §7.11.3 rule 3, §7.11.5). Optional on
   *  purpose: a folder workspace, a host that has not scanned yet, or a detached
   *  main worktree has no name here, and the form then starts empty and asks
   *  instead of guessing `main` (`worktree-delivery` §1). The confirm always
   *  labels it `默认值 · 需确认`, so a filled field is still a question. */
  targetBranchDefault?: string
}

// Why: components import every view type from one module, so they never reach
// into `shared/` twice. Re-export only — these shapes stay defined upstream.
export type { DashboardBucket, DashboardCard, DashboardCardReview }

// Why: the layout input/output live next to the pure decision function, but every
// consumer that needs them already imports this module for the view types. One
// import site keeps a component from depending on the module graph. No cycle:
// `task-workbench-layout.ts` imports nothing.
export type { TaskWorkbenchLayout, TaskWorkbenchLayoutInput } from './task-workbench-layout'
