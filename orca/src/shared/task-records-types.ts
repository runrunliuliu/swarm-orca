import type { AgentType } from './agent-status-types'
import type { AgentJournalTurnOutcome } from './agent-turn-outcome'
import type { AutomationRunUsageUnavailableReason } from './automations-types'
import type { ExecutionHostId } from './execution-host'
import type { TaskProviderIdentity } from './task-provider-identity'
import type { TaskProvider } from './task-providers'

/**
 * The `taskRecords` profile-state domain (design doc §8.3, development plan
 * §M2b). It stores the task entity and the **snapshot facts** an archived or
 * deleted workspace would otherwise take with it: which worktrees ran it, the
 * agent sessions those worktrees reported, the runs behind those sessions
 * (issue #53), and the usage figure that was settled before the workspace
 * stopped being readable. Every stored row carries the observation that produced
 * it — `source` plus `recordedAt` (archive snapshot / removal snapshot /
 * backfill) — so a reader can tell a fact measured at the irreversible moment
 * from one reconstructed afterwards.
 *
 * What is deliberately absent: runtime state (needs you / working / done),
 * `retainedAgentsByPaneKey` (the renderer's derived agent rows), message content
 * and live token figures. Those stay derived from the one authoritative store
 * that owns them (design doc §8.4), so this domain can never drift into a second
 * opinion; persisting the agent rows would hand the hook server a second truth
 * about who is running. What is stored instead is the frozen observation with
 * `recordedAt`, which takes part in no live count.
 *
 * The key shape is `task:<repoId>:<itemType>:<number>`. It carries no host id
 * because an Orca repo id already names one registration on one host, so two
 * hosts cannot collide (`externalKey` in §8.3 spells the host out for the same
 * reason; the repo id subsumes it). It does carry `itemType`, because issue #31
 * and PR #31 in one repository are two different tasks.
 */
export const TASK_RECORDS_VERSION = 1
/** Bumped to 2 when `runs` (and the sessions' snapshot fields) arrived, and to 3
 *  when `runs` gained the `live-observation` source (a run written while it is
 *  still running, so a closed TUI keeps its row). The bump exists so an older
 *  build rejects the whole domain verbatim instead of rebuilding a record
 *  without the rows it cannot read. The stored version is the record's own: an
 *  older record keeps its version on load, and only a write that actually
 *  stores a fact of that generation raises it (see the writers in
 *  `task-records-updates.ts`). */
export const TASK_RECORD_SCHEMA_VERSION = 3
/** The generation that added `runs` / `gaps` and the sessions' snapshot fields.
 *  Named separately because a record this build *creates* holds no run yet: it
 *  starts at this version and is raised to `TASK_RECORD_SCHEMA_VERSION` only by
 *  a write that stores a v3 fact. Creating every new record at v3 would make a
 *  downgrade lose the history of tasks that never used the new channel. */
export const TASK_RECORD_RUNS_SCHEMA_VERSION = 2

/** Bounds (development plan §M2b A). A refusal is an error, never a truncation. */
export const TASK_RECORDS_MAX_BINDINGS_PER_RECORD = 64
export const TASK_RECORDS_MAX_SESSIONS_PER_BINDING = 32
/** 16 runs per binding (issue #53). Over the cap is a refusal, never a
 *  truncation: a run row is a fact a reader uses to conclude "this workspace did
 *  not run that agent", so a silently dropped row is a false negative. */
export const TASK_RECORDS_MAX_RUNS_PER_BINDING = 16
/** 32 KiB, not the 8 KiB in the plan's table: that number cannot hold the same
 *  table's 64-binding limit, because one binding (worktree id, repo id, host,
 *  path, timestamps) is 150–250 bytes before any session. 32 KiB keeps both rules
 *  reachable and still bounds one record; the domain bound below is what caps the
 *  whole payload. */
export const TASK_RECORDS_MAX_RECORD_BYTES = 32 * 1024
export const TASK_RECORDS_MAX_DOMAIN_BYTES = 8 * 1024 * 1024

export const TASK_RECORD_USAGE_PROVIDERS = ['claude', 'codex', 'opencode', 'muse'] as const
export type TaskRecordUsageProvider = (typeof TASK_RECORD_USAGE_PROVIDERS)[number]

/** Same two values as the workbench page and the old ledger: a GitLab MR is a
 *  `pr` here, because the task page it opens is the same shape. */
export type TaskRecordItemType = 'issue' | 'pr'

export type TaskRecordOrigin =
  | {
      kind: 'external'
      provider: TaskProvider
      /** Provider-side identity when the workspace carried one; display only. */
      providerIdentity?: TaskProviderIdentity | null
      itemType: TaskRecordItemType
      number: number
      url?: string
      titleSnapshot?: string
      titleSnapshotAt?: number
    }
  | { kind: 'workspace'; primaryWorktreeId: string }

/** Which evidence resolved a binding's locator (§M2b D). */
export type TaskRecordResolvedVia = 'locator' | 'identity' | 'alias'

/** How one observation reached the record (issue #53). `live-observation` is the
 *  hook status row while the agent runs (written continuously, so a TUI closed
 *  mid-task keeps its row); `archive-snapshot` and `removal-snapshot` are frozen
 *  at the irreversible moment by this build; `backfill` is the explicit,
 *  repeatable reconstruction from local evidence (agent session index +
 *  transcript). The value answers "how reliable is this row", so it is never
 *  defaulted: a row is written by one of these paths or not written at all. */
export const TASK_RECORD_SNAPSHOT_SOURCES = [
  'live-observation',
  'archive-snapshot',
  'removal-snapshot',
  'backfill'
] as const
export type TaskRecordSnapshotSource = (typeof TASK_RECORD_SNAPSHOT_SOURCES)[number]

/** An absence the writer could see and could not resolve. It is stored instead
 *  of an empty result, because "no agent ran here" and "nobody could tell which
 *  agent ran here" read identically as zero rows and only the first is a fact.
 *
 *  There is deliberately no transcript-unreachable kind: reachability is checked
 *  by the reader (a `stat` when the row is displayed), so a writer that recorded
 *  one would claim a verification it never performed. */
export const TASK_RECORD_GAP_KINDS = ['session_unattributable', 'ambiguous_match'] as const
export type TaskRecordGapKind = (typeof TASK_RECORD_GAP_KINDS)[number]

export type TaskRecordGap = {
  kind: TaskRecordGapKind
  /** How many candidates the observation saw. Absent when it did not count
   *  them; `0` here is a measured "looked and found none", never an unknown, and
   *  `ambiguous_match` always has at least two. */
  candidateCount?: number
  /** When the absence was observed (ms). */
  observedAt: number
  /** Why the observation refused to guess; the panel shows it as the reason. */
  detail?: string
}

/** The `stat` vocabulary of the transcript check. `missing` is only ever written
 *  when a local `stat` proved ENOENT: a host that could not look (remote, WSL
 *  gated, EACCES, unknown) reports `unverifiable`, because "this host cannot see
 *  the file" is not evidence that the trace is gone. */
export const TASK_RECORD_TRANSCRIPT_PRESENCES = ['present', 'missing', 'unverifiable'] as const
export type TaskRecordTranscriptPresence = (typeof TASK_RECORD_TRANSCRIPT_PRESENCES)[number]

/** One `stat` of the transcript file — the "check values" issue #53 stores so a
 *  trace can be judged without storing any transcript content (privacy
 *  constraint: paths and check values only).
 *
 *  Absent `transcriptCheck` on a row means "never checked" (the path may still be
 *  stored); it is never a placeholder zero. The fields describe **one** stat of
 *  one file, so the merge (see `task-records-runs-merge.ts`) replaces the whole
 *  check with the newest one instead of mixing `size` from one stat with
 *  `mtimeMs` of another. */
export type TaskRecordTranscriptCheck = {
  /** When the stat was taken (ms). Required: an undated measurement cannot be
   *  weighed against a later one. */
  checkedAt: number
  presence: TaskRecordTranscriptPresence
  /** Device / inode / mtime / size as the platform reported them. Absent when the
   *  platform did not report one, or when the host could not look at the file at
   *  all — unknown, never `0`. */
  dev?: number
  ino?: number
  mtimeMs?: number
  size?: number
}

/**
 * One agent session a workspace reported. `key` is the provider's own field name
 * (`session_id`, `conversation_id`, …) rather than a union, so a provider this
 * build does not know yet still round-trips instead of being dropped.
 *
 * `provider` is absent when the pane's agent could not be identified (an agent
 * the user started by hand in a plain tab). Absent is "unknown", which is what
 * the ambiguity rule below needs: two providers claiming one `key:id` is not a
 * duplicate to merge, it is a claim this record may not resolve.
 */
export type TaskRecordSession = {
  provider?: TaskRecordUsageProvider
  key: string
  id: string
  transcriptPath?: string
  /** Snapshot facts (issue #53), every one optional: absent means "not
   *  observed", never a placeholder — no `0` token figure, no epoch start, and
   *  never the record's creation time standing in for a measured wall clock.
   *  `agentType` is the shared agent vocabulary, not the four-value usage
   *  provider enum: who ran is not the same question as whose tokens these are
   *  (pi is a valid agent type and not a usage provider).
   *
   *  `agentType` is deliberately the **open** `AgentType` vocabulary (well-known
   *  names plus any string, because agent types are not a fixed set), so the load
   *  boundary accepts any non-empty string for it and a fabricated agent name is
   *  not one of T4's dirty fields; `provider` and `outcome` are closed and are
   *  validated. Do not "fix" this into an enum. */
  agentType?: AgentType
  title?: string
  /** The provider CLI command that resumes this session in its checkout, taken
   *  from the session index (`resume_command`). Absent when the observation had
   *  none — the hook path never has one — and never a command this build
   *  composed itself. */
  resumeCommand?: string
  startedAt?: number
  endedAt?: number
  messageCount?: number
  /** Which observation supplied this row and when. Absent on a v1 row, which is
   *  itself information: that row predates the snapshot writer. */
  source?: TaskRecordSnapshotSource
  recordedAt?: number
  /** Check values of `transcriptPath` at the time of the observation. Absent =
   *  never checked; the newest check wins on merge (see
   *  `task-records-runs-merge.ts`). */
  transcriptCheck?: TaskRecordTranscriptCheck
  firstSeenAt: number
  lastSeenAt: number
}

/** The provider claim a run is bound to, so a resume/`locate trace` action has
 *  the same `key:id` the session row carries. */
export type TaskRecordProviderSession = {
  /** Absent when the agent is not one of the four usage providers (pi, for one).
   *  The run still exists; only the token attribution is unknown. */
  provider?: TaskRecordUsageProvider
  key: string
  id: string
}

/** One agent run inside one binding (issue #53): the facts a review, a resume
 *  or a trace lookup needs, frozen with the observation that produced them.
 *
 *  Identity for merging is the claim `provider|key:id` (see
 *  `taskRecordRunClaimKey`), so replaying a snapshot updates the row instead of
 *  appending a duplicate. Every fact that may be unknown is optional and absent
 *  means unknown, so the renderer's history row can be produced without
 *  inventing a wall-clock edge, a title or a message count. */
export type TaskRecordRun = {
  /** Stable identity of the run inside its binding. Always the claim string
   *  (`taskRecordRunClaimKey`), so the page has a stable row key; the merge keys
   *  on the claim itself, so a caller that passes something else still cannot
   *  turn one session into two rows. */
  key: string
  providerSession: TaskRecordProviderSession
  title?: string
  /** Same open vocabulary as `TaskRecordSession.agentType` (see there). */
  agentType?: AgentType
  /** The provider CLI command that resumes this run's session; absent when the
   *  observation could not supply one (the hook path has none). */
  resumeCommand?: string
  startedAt?: number
  endedAt?: number
  messageCount?: number
  /** The provider's own verdict; absent means unknown, never success. */
  outcome?: AgentJournalTurnOutcome
  transcriptPath?: string
  /** Check values of `transcriptPath`, as on the session row: a measured fact, so
   *  the newest `checkedAt` wins on merge and an equal timestamp keeps the stored
   *  check. */
  transcriptCheck?: TaskRecordTranscriptCheck
  /** Which observation produced this row. Always known: a row exists only
   *  because some observation stated it. */
  source: TaskRecordSnapshotSource
  recordedAt: number
  /** Absences observed about *this* run. */
  gaps?: TaskRecordGap[]
  /** Observation window of the claim (min/max over every observation), not the
   *  run's measured wall clock — that is `startedAt`/`endedAt`. */
  firstSeenAt: number
  lastSeenAt: number
}

/** The merge identity of one run: the provider claim, exactly as the session
 *  row spells it (`sessionKey:sessionId`, provider omitted when unknown). */
export function taskRecordRunClaimKey(providerSession: TaskRecordProviderSession): string {
  return `${providerSession.provider ?? 'unknown'}|${providerSession.key}:${providerSession.id}`
}

export type TaskRecordUsageUnavailableReason = Extract<
  AutomationRunUsageUnavailableReason,
  | 'usage_not_enabled'
  | 'remote_usage_unavailable'
  | 'scan_failed'
  | 'no_matching_session'
  | 'ambiguous_session'
>

export type TaskUsageSettlementProvider = {
  provider: TaskRecordUsageProvider
  tokens: number
  /** Null means unpriced for this provider (Muse publishes no cost), never `$0`. */
  costUsd: number | null
}

/**
 * The usage figure written before the workspace stopped being readable
 * (development plan §M2b C). A union rather than `{ totalTokens, reason? }`
 * because a missing figure must not have a number field to print as `0`: the
 * unavailable arm has no `tokens`/`costUsd` member at all.
 *
 * It lives on the binding, not on the record, because the plan settles the
 * *removed binding's* workspace rollup; two removed workspaces of one task are
 * two snapshots, and a single record-level field would silently keep only the
 * last one.
 */
export type TaskUsageSettlement =
  | {
      kind: 'known'
      collectedAt: number
      scope: 'worktree-rollup'
      worktreeId: string
      providers: TaskUsageSettlementProvider[]
      /** Null when any contributing provider is unpriced: unknown, never 0. */
      estimatedCostUsd: number | null
    }
  | {
      kind: 'unavailable'
      collectedAt: number
      scope: 'worktree-rollup'
      worktreeId: string
      reason: TaskRecordUsageUnavailableReason
    }

export type TaskWorkspaceBinding = {
  worktreeId: string
  repoId: string
  hostId: ExecutionHostId
  /** Checkout path kept after deletion so a removed workspace can still be named. */
  path: string
  isArchived: boolean
  boundAt: number
  boundBy: 'created' | 'user' | 'reconciled'
  /** Null until evidence confirms the locator; never overwritten back to null. */
  lastVerifiedAt: number | null
  resolvedVia?: TaskRecordResolvedVia
  sessions: TaskRecordSession[]
  /** v2. Absent on a v1 binding and that is not the same as `[]`: absent means
   *  "no build recorded runs here yet", while an empty array means the snapshot
   *  writer looked and stored none — which is where a `gaps` row explains why. */
  runs?: TaskRecordRun[]
  /** v2. Absences that belong to the binding rather than to one run
   *  (`session_unattributable`, `ambiguous_match`): the writer had nothing it
   *  could write a run for. */
  gaps?: TaskRecordGap[]
  usageSettlement?: TaskUsageSettlement
}

export type TaskRecordIntent = {
  /** Set by the task-archive action; absent means "not archived", never "unknown". */
  archived?: boolean
  acceptance?: string
}

export type TaskRecordsRemovalSnapshot = {
  /** The figure this build measured before the checkout stopped being readable,
   *  or `null` when it has no provider usage store at all (the headless `orcad`
   *  root: the four stores import `app` from `electron` at module scope and are
   *  not in that bundle).
   *
   *  `null` is "this build did not measure", and it is deliberately **not** the
   *  `unavailable` arm: every existing reason there states something that never
   *  happened in such a runtime — `usage_not_enabled` names a user setting the
   *  build does not have, and `no_matching_session` would be a measured zero.
   *  The removal write stores no settlement at all for `null`, which is the same
   *  rule the archive snapshot already follows, so a reader keeps the states
   *  apart: field absent = not measured by this build; `unavailable` + reason =
   *  measured, figure missing; `known` = a number. The other fields of this
   *  snapshot (the frozen session list) are unchanged. */
  settlement: TaskUsageSettlement | null
  /** Provider sessions the workspace reported before it stopped being readable. */
  sessions: TaskRecordSession[]
}

export type TaskRecord = {
  taskId: string
  hostId: ExecutionHostId
  origin: TaskRecordOrigin
  /** 0..N. Order is bind order, which is what the panel renders. */
  bindings: TaskWorkspaceBinding[]
  primaryWorktreeId?: string
  intent: TaskRecordIntent
  createdAt: number
  updatedAt: number
  schemaVersion: number
}

export type TaskRecordsState = {
  recordsVersion: number
  byId: Record<string, TaskRecord>
  /** `<repoId>:<itemType>:<number>` → taskId; 0..1 per key (plan §M2b A). */
  externalIndex: Record<string, string>
}

export const EMPTY_TASK_RECORDS: TaskRecordsState = {
  recordsVersion: TASK_RECORDS_VERSION,
  byId: {},
  externalIndex: {}
}

export function isTaskRecordUsageProvider(value: unknown): value is TaskRecordUsageProvider {
  return TASK_RECORD_USAGE_PROVIDERS.some((provider) => provider === value)
}

export function isTaskRecordItemType(value: unknown): value is TaskRecordItemType {
  return value === 'issue' || value === 'pr'
}

export function isTaskRecordUsageUnavailableReason(
  value: unknown
): value is TaskRecordUsageUnavailableReason {
  return (
    value === 'usage_not_enabled' ||
    value === 'remote_usage_unavailable' ||
    value === 'scan_failed' ||
    value === 'no_matching_session' ||
    value === 'ambiguous_session'
  )
}

export function isTaskRecordResolvedVia(value: unknown): value is TaskRecordResolvedVia {
  return value === 'locator' || value === 'identity' || value === 'alias'
}

export function isTaskRecordSnapshotSource(value: unknown): value is TaskRecordSnapshotSource {
  return TASK_RECORD_SNAPSHOT_SOURCES.some((source) => source === value)
}

export function isTaskRecordGapKind(value: unknown): value is TaskRecordGapKind {
  return TASK_RECORD_GAP_KINDS.some((kind) => kind === value)
}

export function isTaskRecordTranscriptPresence(
  value: unknown
): value is TaskRecordTranscriptPresence {
  return TASK_RECORD_TRANSCRIPT_PRESENCES.some((presence) => presence === value)
}

/** What the load boundary refused to keep from the observation rows, by kind.
 *  Counted rather than swallowed: a payload that lost rows (a hand edit, a
 *  downgrade, an over-cap array) must be reportable, and a reader that sees zero
 *  rows has to be able to tell "nothing ran" from "nothing could be read". */
export type TaskRecordsDiscardedFacts = {
  /** Session rows dropped for a malformed shape. */
  sessions: number
  /** Run rows dropped for a malformed shape, or over the per-binding cap. */
  runs: number
  /** Gap rows dropped for a malformed shape. */
  gaps: number
  /** Provider values this build does not know, removed from a kept row. */
  providers: number
  /** Field values inside a kept row that this build cannot read, plus the names
   *  of fields it does not know at all. */
  fields: number
  /** Transcript checks this build could not read (an illegal `presence`, or a
   *  `checkedAt` it cannot weigh). The row is kept — only the check is dropped. */
  transcriptChecks: number
}

export function emptyDiscardedFacts(): TaskRecordsDiscardedFacts {
  return { sessions: 0, runs: 0, gaps: 0, providers: 0, fields: 0, transcriptChecks: 0 }
}

/**
 * False for a payload this build cannot interpret: an unknown `recordsVersion`,
 * a non-object `byId`, or a record written by a newer schema. The load path
 * keeps such a payload verbatim — it is never replaced by an empty domain — and
 * every writer refuses to run, which is the fail-closed arm of development plan
 * §M2b F.
 *
 * Why one newer record makes the *whole domain* unreadable: normalization can
 * only keep what it understands, so loading the rest and saving on the next
 * metadata write would silently delete the record this build cannot read. The
 * cost is that a downgraded build shows no task history until the newer build
 * is back; losing another build's record is the worse failure.
 */
export function isReadableTaskRecords(value: unknown): value is TaskRecordsState {
  if (value === undefined) {
    return true
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (!('recordsVersion' in value) || value.recordsVersion !== TASK_RECORDS_VERSION) {
    return false
  }
  if (!('byId' in value)) {
    return false
  }
  const byId = value.byId
  if (typeof byId !== 'object' || byId === null || Array.isArray(byId)) {
    return false
  }
  for (const record of Object.values(byId)) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      continue
    }
    const schemaVersion = (record as { schemaVersion?: unknown }).schemaVersion
    // `1e999` parses to Infinity; a non-finite number is not a schema this build
    // can interpret, and normalizing it would rewrite the record as current.
    if (
      typeof schemaVersion === 'number' &&
      (!Number.isFinite(schemaVersion) || schemaVersion > TASK_RECORD_SCHEMA_VERSION)
    ) {
      return false
    }
  }
  if ('externalIndex' in value) {
    const externalIndex = value.externalIndex
    if (typeof externalIndex !== 'object' || externalIndex === null) {
      return false
    }
  }
  return true
}
