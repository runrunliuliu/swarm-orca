import type { WorktreeCatalogVersion } from './catalog-version'
import type { ExecutionHostId } from '../execution-host'
import type { ArchiveHookOverride } from './archive-hook-removal-gate'
import type { WorkspaceSource } from '../workspace-source'
import type { TaskSourceContext } from '../task-source-context'
import type { WorkspaceKey } from '../folder-workspace-types'
import type { TuiAgent } from '../tui-agent'
import type {
  AutomationWorkspaceProvenanceRequest,
  GitPushTarget,
  GitWorktreeInfo,
  WorkspaceLinkedItem,
  WorkspaceStatus,
  Worktree
} from './types'
import type { WorkspaceLineage, WorktreeLineage, WorktreeLineageWarning } from './lineage-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './launch-types'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion,
  WorktreeBaseStatusEvent
} from './base-ref-drift-types'

export type SetupDecision = 'inherit' | 'run' | 'skip'

export type WorktreeCreateTimingPhase = {
  phase: string
  startedAtMs: number
  durationMs: number
}

/** Closed vocabulary: these values reach span attributes, so none of them may ever
 *  be derived from a branch name, a ref, or a path. */
export type PreparedCheckoutMissReason =
  | 'none_armed'
  /** Preparations exist, but none for this repo — it was never warmed, or the pool's size cap
   *  evicted it for another repo. Distinguished from `none_armed` because it is the signal that
   *  the cap is thrashing for a multi-project user. */
  | 'repo_mismatch'
  | 'base_mismatch'
  | 'retarget_too_divergent'
  /** The drift check returned no answer. Distinct from `retarget_too_divergent` because that one
   *  is the bound working as intended, while this one means a possibly cheap retarget was skipped
   *  anyway. Deliberately a mixed bucket — a blown deadline, a cancelled create, and an ordinary
   *  Git failure such as a missing ref all land here — so treat a rise as "look at why", not as a
   *  direct readout of the budget being too small. */
  | 'retarget_unverifiable'
  | 'workspace_root_mismatch'
  | 'wsl_distro_mismatch'
  | 'prepare_failed'
  | 'finalize_failed'
  | 'checkout_existing_branch'
  | 'sparse_checkout'

/** Whether a create reused a prewarmed checkout, and when it did not, which part of
 *  the claim key disagreed. `retargeted` marks a hit that had to reset the prepared
 *  checkout onto a different ref in the same base family. */
export type PreparedCheckoutOutcome =
  | { status: 'hit'; retargeted: boolean }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

export type WorktreeCreateTiming = {
  totalDurationMs: number
  phases: WorktreeCreateTimingPhase[]
  preparedCheckout?: PreparedCheckoutOutcome
}

/** The only payload value that turns on the task sparse contract. Absent keeps legacy sparse
 *  creation: same trimming/dedupe, no pinned base, no receipt, and no readback gate. */
export const SPARSE_TASK_CHECKOUT_MODE = 'task-workspace-v1' as const
export type SparseTaskCheckoutMode = typeof SPARSE_TASK_CHECKOUT_MODE

// M0 request limits. Shared because a client must be able to refuse an over-limit request before
// sending it; the host enforces the same numbers before any Git work. Only the task-workspace
// request path applies them — a legacy sparse payload keeps its historical behavior.
export const SPARSE_TASK_MAX_DIRECTORY_COUNT = 128
export const SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES = 16 * 1024
export const SPARSE_TASK_MAX_REQUIRED_PATH_COUNT = 256
export const SPARSE_TASK_MAX_REQUIRED_PATH_UTF8_BYTES = 32 * 1024


export type CreateSparseCheckoutRequest = {
  directories: string[]
  /** Set when the directories came from a saved preset and the user did not
   *  modify them — recorded on WorktreeMeta so the worktree can show "from
   *  preset X" later. Cleared if the user edited the textarea. */
  presetId?: string
  /** Opts into the task sparse contract (pinned base + readback receipt). */
  mode?: SparseTaskCheckoutMode
  /** Repo-relative paths a task workspace must have before start-up. Parsed on the wire so a host
   *  that cannot verify them refuses the create instead of silently dropping the requirement. */
  requiredPaths?: string[]
}
/**
 * What a task sparse create read back from the worktree it just made. Only the negotiated path
 * returns one, and only after HEAD and the effective cone were checked against the pinned request;
 * a legacy sparse create keeps returning exactly what it returned before.
 */
export type SparseTaskWorkspaceReceipt = {
  /** Whether the base came from the caller's `baseBranch` or from the creator's default. */
  baseSource: 'request' | 'default'
  /** The ref that was resolved before creation, so the caller can tell which ref the pin came from. */
  resolvedRef: string
  /** Full commit SHA the worktree was created at, not the (movable) base ref. */
  pinnedSha: string
  /** HEAD read back from the created worktree; the create fails unless this equals `pinnedSha`. */
  actualHead: string
  /** Requested cone, in first-seen order, deduplicated. */
  requestedSparseCone: string[]
  /** Cone read back from the created worktree's sparse-checkout state. */
  effectiveSparseCone: string[]
  /** Declared required paths, strictly parsed and verified present in the created worktree. */
  requiredPaths: string[]
}

/** A reusable per-repo sparse directory list. Saved by the user from the
 *  composer; surfaced again the next time they create a worktree in the same
 *  repo. The MVP scope (no preset) is `presetId === undefined`. */
export type SparsePreset = {
  id: string
  repoId: string
  name: string
  directories: string[]
  createdAt: number
  updatedAt: number
}

export type CreateWorktreeArgs = {
  repoId: string
  name: string
  /** True only when `name` came from Orca's creature-name generator rather than the user. Gates
   *  name retirement: a generated name is never reissued, but `Orca`, `Runner` and `Molly` are all
   *  in that pool, so a name the user typed must stay reusable. Defaults to false, which keeps
   *  CLI and automation callers on the pre-retirement behavior. */
  nameWasGenerated?: boolean
  /** Optional user-facing label to persist separately from the git-safe
   *  branch/path seed. Used when a workspace is created from a GitHub or
   *  Linear artifact whose title should remain readable in the sidebar. */
  displayName?: string
  /** Distinguishes user labels from generated artifact titles at creation time. */
  displayNameKind?: 'generated' | 'user'
  baseBranch?: string
  /** Source Control compare target when it differs from the checkout start point. */
  compareBaseRef?: string
  /** Optional git branch to create, separate from the filesystem-safe worktree
   *  name. Used when creating from an existing branch whose local branch name
   *  legitimately contains `/` while the worktree directory must not. */
  branchNameOverride?: string
  setupDecision?: SetupDecision
  /** Legacy per-hook opt-in that travels beside `setupDecision` on the wire. Kept as its own field
   *  rather than folded into the decision because the task sparse contract refuses it explicitly
   *  (`assertSparseTaskSetupSkipped`) and old callers' `--run-hooks` must keep its exact meaning. */
  runHooks?: boolean
  sparseCheckout?: CreateSparseCheckoutRequest
  linkedIssue?: number
  linkedPR?: number
  linkedLinearIssue?: string
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedGitLabIssue?: number
  linkedGitLabMR?: number
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
  pushTarget?: GitPushTarget
  workspaceStatus?: WorkspaceStatus
  manualOrder?: number
  /** Parent workspace for in-app creates launched from a folder workspace. */
  parentWorkspace?: WorkspaceKey
  /** Agent selected in the create surface. Omitted for blank-shell creates. */
  createdWithAgent?: TuiAgent
  /** Set when the renderer knows this auto-generated branch should be renamed
   *  from the first agent message. */
  pendingFirstAgentMessageRename?: boolean
  /** Telemetry-only: which UI surface initiated this create. Threaded from
   *  the renderer entry point so main can emit `workspace_created` with the
   *  correct `source`. `unknown` is a valid wire value — an unrecognized
   *  surface emits `source: 'unknown'` rather than dropping the event, so
   *  dashboards surface enum-coverage gaps as a slice rather than as
   *  missing data. Optional on the type so older renderer code paths that
   *  pre-date this prop default to `unknown` at the IPC boundary instead
   *  of failing typecheck. */
  telemetrySource?: WorkspaceSource
  /** Optional startup command for callers that want the backend to spawn the
   *  first terminal as soon as the worktree is registered. */
  startup?: WorktreeStartupLaunch
  /** Correlates `createWorktree:progress` events back to a specific pending
   *  creation in the renderer, so concurrent background creates each drive
   *  their own status surface. Omitted by synchronous callers. */
  creationId?: string
  /** Authorizes the host to mint system-owned automation provenance. */
  automationProvenanceRequest?: AutomationWorkspaceProvenanceRequest
}

export type AdoptProvisionedRootArgs = CreateWorktreeArgs & {
  runtimeId: string
  executionHostId: ExecutionHostId
  expectedPath: string
  expectedRefHead?: string
}

export type CreateWorktreeResult = {
  /** The catalog this create produced; additive, older hosts omit it. */
  catalogVersion?: WorktreeCatalogVersion
  worktree: Worktree & {
    parentWorktreeId?: string | null
    childWorktreeIds?: string[]
    lineage?: WorktreeLineage | null
    workspaceLineage?: WorkspaceLineage | null
    git?: GitWorktreeInfo
  }
  lineage?: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  warnings?: WorktreeLineageWarning[]
  setup?: WorktreeSetupLaunch
  setupReceipt?: {
    requested: 'run' | 'skip' | 'inherit'
    hookFound: boolean
    startupPolicy: 'start-immediately' | 'wait-for-setup'
    state: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
    terminalHandle?: string
  }
  defaultTabs?: WorktreeDefaultTabsLaunch
  warning?: string
  /** Present only for the task sparse contract (`sparseCheckout.mode`); see
   *  `SparseTaskWorkspaceReceipt` for what was verified before this was returned. */
  sparseCheckoutReceipt?: SparseTaskWorkspaceReceipt
  baseFallback?: WorktreeCreateBaseFallback
  initialBaseStatus?: WorktreeBaseStatusEvent
  localBaseRefRefresh?: LocalBaseRefRefreshResult
  localBaseRefUpdateSuggestion?: LocalBaseRefUpdateSuggestion
  startupTerminal?: {
    spawned: boolean
    handle?: string
    tabId?: string
    paneKey?: string | null
    ptyId?: string | null
    surface?: 'visible' | 'background'
  }
  timing?: WorktreeCreateTiming
}

export type WorktreeCreateBaseFallback = {
  requestedRef: string
  localRef: string
}

export type PreservedWorktreeBranch = {
  branchName: string
  head?: string
}

export type RemoveWorktreeResult = {
  /** The catalog this removal produced; additive, older hosts omit it. */
  catalogVersion?: WorktreeCatalogVersion
  preservedBranch?: PreservedWorktreeBranch
  /** Present only when a FAILED archive hook was explicitly waived for this removal (#19334). */
  archiveHookOverride?: ArchiveHookOverride
}

export type ForceDeleteWorktreeBranchResult = {
  deleted: true
}
