import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import type { AgentJournalTurnOutcome } from '../../shared/agent-turn-outcome'
import {
  taskRecordRunClaimKey,
  type TaskRecordSession,
  type TaskRecordsRemovalSnapshot,
  type TaskRecordUsageProvider,
  type TaskUsageSettlement,
  type TaskUsageSettlementProvider
} from '../../shared/task-records-types'
import type { TaskRecordsArchiveSnapshotDeps } from './task-records-archive-snapshot'

/**
 * The settlement figure written before a workspace stops being readable
 * (development plan §M2b C). It reads the four `*UsageProjectBreakdown` rows the
 * renderer already shows, filtered to this one worktree key, and turns them into
 * the domain's settlement union.
 *
 * Why here and not in the renderer: the removal is a main-process event, and the
 * write must happen before the worktree row is dropped. The renderer's copy of
 * the same numbers can be a minute stale, and a stale number written once is
 * indistinguishable from a measured one afterwards.
 *
 * No forced rescan: `getSnapshot` reads what the last scan produced. Triggering a
 * scan on removal would make a delete wait on four provider scans, and a scan
 * started for an already-removed worktree could not attribute anything anyway.
 */

/** The four provider stores, narrowed to the two reads this module performs and
 *  to the row fields it actually totals. Declared structurally rather than as
 *  `Pick<ClaudeUsageStore, …>` so a test can supply one row shape per provider
 *  instead of a whole usage snapshot; each real store still satisfies it. */
type ClaudeProjectRow = {
  key: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  estimatedCostUsd: number | null
}

type TotalTokensProjectRow = {
  key: string
  totalTokens: number
  estimatedCostUsd: number | null
}

export type TaskRecordsUsageRead<Row extends { key: string }> = {
  getScanState(): { enabled: boolean }
  getSnapshot(scope: 'orca', range: 'all'): { projectBreakdown: readonly Row[] }
}

export type TaskRecordsUsageStoreSet = {
  claude: TaskRecordsUsageRead<ClaudeProjectRow>
  codex: TaskRecordsUsageRead<TotalTokensProjectRow>
  opencode: TaskRecordsUsageRead<TotalTokensProjectRow>
  muse: TaskRecordsUsageRead<{ key: string; totalTokens: number }>
}

/** The snapshot facts a hook status row can state about one pane's agent (issue
 *  #53 §4). Structural on purpose: this module must not import the hook server,
 *  and a test can supply one row instead of the whole transport type. Everything
 *  but `state` is optional because the source genuinely omits some — see
 *  `hookSessionFacts`, which is the only place that decides which. `state` is
 *  required because the verdict predicate reads it and every row of the status
 *  feed states one.
 *
 *  Deliberately not here: `messageCount` and `title`. The hook status payload
 *  carries neither (a terminal title is renderer state, a message count is a
 *  transcript fact), so they stay absent on this path and are filled by the
 *  session index (seat C's backfill) instead of being invented from a prompt.
 */
export type HookAgentStatusFacts = {
  paneKey: string
  agentType?: AgentType
  state: AgentStatusState
  stateStartedAt?: number
  /** A `done` that only means "connected idle", not a completed turn. */
  sessionBoundary?: boolean
  /** The verdict-bearing fields, exactly as the same row carries them, so
   *  `agentMainAgentVerdict` decides what a Stop means instead of this join
   *  restating the rule. */
  interrupted?: boolean
  mainAgent?: { state: AgentStatusState; outcome?: AgentJournalTurnOutcome }
}

/** One provider session the hook server currently knows. `key` is absent when
 *  the reporting provider only gave an id. */
export type TaskRecordSessionIdentity = {
  paneKey: string
  sessionId: string
  key?: string
  transcriptPath?: string
  worktreeId?: string
  /** Snapshot facts, same source (`providerSession`'s hook status row). Absent
   *  means the source has no such fact, never a placeholder value. */
  agentType?: AgentType
  startedAt?: number
  endedAt?: number
  messageCount?: number
  title?: string
  /** The turn verdict the *same* hook status row recorded, read through
   *  `agentMainAgentVerdict`. Absent on a plain Stop, on a pane the server no
   *  longer holds and on the index path: absent means unknown, never success. */
  outcome?: AgentJournalTurnOutcome
}

/**
 * The archive snapshot's session list plus the verdicts the same hook rows stated.
 *
 * `outcome` is a fact about a *run*, and the shared `TaskRecordSession` row has no
 * field for it (a session can span several turns), so it travels beside the list
 * keyed by the run claim (`taskRecordRunClaimKey`) instead of widening a frozen
 * row shape. Only the pane-attributed path can state one: the index/backfill path
 * reads a transcript, which records what was said, not the provider's verdict.
 */
export type TaskRecordsArchiveSnapshot = Omit<TaskRecordsRemovalSnapshot, 'settlement'> & {
  /** The settlement this runtime measured, or `null` when it has no provider usage
   *  store at all (the headless `orcad` root: the four stores import `app` from
   *  `electron` at module scope and are not in that bundle).
   *
   *  `null` is "this build did not measure", and it is deliberately **not** the
   *  `unavailable` arm: every existing reason there states something that never
   *  happened in such a runtime — `usage_not_enabled` names a user setting the build
   *  does not have, and `no_matching_session` would be a measured zero. The archive
   *  write stores no settlement at all for `null` (`applyArchiveSnapshot` already has
   *  that arm), so a reader keeps three states apart: field absent = not measured by
   *  this build; `unavailable` + reason = measured, figure missing; `known` = a
   *  number. The removal contract stays non-nullable: a removal settles a workspace
   *  that is going away, where an absent field is not readable the same way. */
  settlement: TaskUsageSettlement | null
  /** Claim → the verdict the hook status row recorded. A claim absent here has no
   *  verdict (a plain Stop, an unheld pane, a removal-fallback source), which is
   *  unknown — never success. */
  outcomes?: ReadonlyMap<string, AgentJournalTurnOutcome>
}

/**
 * Attach the hook status facts to the provider-session identities.
 *
 * The identities come from `agentHookServer.getProviderSessionIdentities()`, which
 * states *which* session a pane reports and nothing about the run; the facts come
 * from the same server's status snapshot. Both are keyed by pane key, so this is a
 * join, not a second source of truth.
 *
 * What a hook row can state, and what it cannot:
 * - `agentType` — the row's own vocabulary (pi included; `provider` stays the
 *   four-value usage enum and is unknown for anything else).
 * - `startedAt` — only while the row is `working`: `stateStartedAt` is when the
 *   *current* state began, which is a run's start only while the run is running.
 * - `endedAt` — the same clock `agentEntryCompletionAt` uses: a non-boundary
 *   `done`'s `stateStartedAt`. A settled row's `stateStartedAt` is its end, so the
 *   two edges are never derived from one value.
 * - `messageCount`, `title` — absent. Never the prompt: a user prompt is content,
 *   not a title, and the issue forbids storing content.
 * - `outcome` — only what the shared predicate reads off the row: a `done` main
 *   agent's recorded verdict, or the user's own interrupt (`cancellation`). A plain
 *   Stop states none, and none stays absent.
 */
export function withHookSessionFacts(
  identities: readonly TaskRecordSessionIdentity[],
  rows: readonly HookAgentStatusFacts[]
): TaskRecordSessionIdentity[] {
  const factsByPane = new Map<string, HookAgentStatusFacts>()
  for (const row of rows) {
    // The snapshot can list several representations of one pane; the first is the
    // one the status feed was built from, so a later duplicate adds nothing.
    if (!factsByPane.has(row.paneKey)) {
      factsByPane.set(row.paneKey, row)
    }
  }
  return identities.map((identity) => ({
    ...identity,
    ...hookSessionFacts(factsByPane.get(identity.paneKey))
  }))
}

/** The facts one hook row states, or none when the server no longer holds the pane. */
export function hookSessionFacts(
  row: HookAgentStatusFacts | undefined
): Pick<TaskRecordSessionIdentity, 'agentType' | 'startedAt' | 'endedAt' | 'outcome'> {
  if (!row) {
    return {}
  }
  const settled = row.state === 'done' && row.sessionBoundary !== true
  const measured = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value)
  // Read through the shared predicate rather than restating what a Stop means: it
  // answers null while the main agent still works, and for a turn nobody recorded a
  // verdict on — so a plain Stop can never enter the record as a success.
  const verdict = agentMainAgentVerdict(row)
  return {
    ...(row.agentType === undefined ? {} : { agentType: row.agentType }),
    ...(row.state === 'working' && measured(row.stateStartedAt)
      ? { startedAt: row.stateStartedAt }
      : {}),
    ...(settled && measured(row.stateStartedAt) ? { endedAt: row.stateStartedAt } : {}),
    ...(verdict === null ? {} : { outcome: verdict })
  }
}

export type TaskRecordsUsageSourceDeps = {
  /** The four provider usage stores. **Optional**, because a composition root can
   *  have none at all: the headless `orcad` root cannot load them (each imports
   *  `app` from `electron` at module scope, and the orcad bundle refuses any
   *  Electron importer), so it binds the session half through this same factory
   *  instead of a second, partial implementation. Absent is not "zero": the archive
   *  snapshot then carries `settlement: null` — no settlement is written at all —
   *  because no existing `unavailable` reason is true of a build that never measured
   *  (see `TaskRecordsArchiveSnapshot.settlement`). A removal still settles with the
   *  factory's own arm, since its contract has no absent case. */
  stores?: TaskRecordsUsageStoreSet
  /** Hook-server snapshot; a session the server no longer knows cannot be listed. */
  sessionIdentities: () => readonly TaskRecordSessionIdentity[]
  /** Which usage provider a pane's agent is, when the tab pins one. */
  providerForPaneKey: (paneKey: string) => TaskRecordUsageProvider | undefined
  /** issue #53's asynchronous archive inputs. Bound here for the same reason the
   *  four usage stores are: they exist only after the Store is constructed, and the
   *  writers that need them receive the source through the runtime. */
  archiveSnapshot?: TaskRecordsArchiveSnapshotDeps
}

export type TaskRecordsUsageSource = {
  snapshotForRemoval(args: {
    worktreeId: string
    hostId: ExecutionHostId
    now: number
  }): TaskRecordsRemovalSnapshot
  /** Freeze the worktree's session list *before* a destructive PTY teardown.
   *  The hook server drops a pane's status (and with it the provider session
   *  identity) as each PTY is killed, so reading it at settlement time — after
   *  teardown — would find nothing for exactly the workspaces being removed. */
  captureSessionsForRemoval(worktreeId: string): void
  /** The archive transition (issue #53 A) is not destructive: same session list and
   *  same settlement, but it must not consume a removal capture, so it reads the
   *  live hook server directly. It is also the only entry that can carry the turn
   *  verdicts its own hook rows stated (`outcomes`). Optional so a source written
   *  before this issue (and every existing test double) keeps working; the archive
   *  write then falls back to `snapshotForRemoval`. */
  snapshotForArchive?(args: {
    worktreeId: string
    hostId: ExecutionHostId
    now: number
  }): TaskRecordsArchiveSnapshot
  /** The asynchronous degraded source, absent when this build has no session index. */
  archiveSnapshot?: TaskRecordsArchiveSnapshotDeps
}

/** A capture older than this was not consumed by a removal (the removal failed
 *  before the metadata row was dropped), so it is no longer evidence. */
const REMOVAL_SESSION_CAPTURE_TTL_MS = 10 * 60 * 1000

export function createTaskRecordsUsageSource(
  deps: TaskRecordsUsageSourceDeps
): TaskRecordsUsageSource {
  const capturedSessions = new Map<
    string,
    { capturedAt: number; sessions: TaskRecordSession[] }
  >()
  const captureSessionsForRemoval = (worktreeId: string): void => {
    const now = Date.now()
    for (const [key, entry] of capturedSessions) {
      if (now - entry.capturedAt > REMOVAL_SESSION_CAPTURE_TTL_MS) {
        capturedSessions.delete(key)
      }
    }
    capturedSessions.set(worktreeId, {
      capturedAt: now,
      sessions: collectWorktreeSessions(deps, worktreeId, now).sessions
    })
  }
  const sessionsForRemoval = (worktreeId: string, now: number): TaskRecordSession[] => {
    const captured = capturedSessions.get(worktreeId)
    if (!captured) {
      return collectWorktreeSessions(deps, worktreeId, now).sessions
    }
    // Consumed once: a second removal of a re-created locator must read the live
    // hook server again, not inherit a dead occupant's sessions.
    capturedSessions.delete(worktreeId)
    // A capture that outlived its TTL was not consumed by the removal it was
    // taken for; it is not evidence for a later one, so read the live server.
    if (now - captured.capturedAt > REMOVAL_SESSION_CAPTURE_TTL_MS) {
      return collectWorktreeSessions(deps, worktreeId, now).sessions
    }
    return captured.sessions
  }
  const settlementFor = (worktreeId: string, hostId: ExecutionHostId, now: number) =>
    // Same judgement as the desktop, with the store set it actually has: no stores
    // is `enabled: false` and no provider rows, so `buildTaskUsageSettlement`
    // returns its existing `unavailable`/`usage_not_enabled` arm. Deliberately not
    // a second branch here: one settlement rule, one place to change it.
    buildTaskUsageSettlement({
      worktreeId,
      hostId,
      now,
      providers: deps.stores ? readProviderRows(deps.stores, worktreeId) : [],
      enabled: deps.stores ? anyProviderEnabled(deps.stores) : false
    })
  const settlementAndSessions = (
    worktreeId: string,
    hostId: ExecutionHostId,
    now: number,
    sessions: TaskRecordSession[]
  ): TaskRecordsRemovalSnapshot => ({
    settlement: settlementFor(worktreeId, hostId, now),
    sessions
  })
  return {
    captureSessionsForRemoval,
    snapshotForRemoval: ({ worktreeId, hostId, now }) =>
      settlementAndSessions(worktreeId, hostId, now, sessionsForRemoval(worktreeId, now)),
    // A capture belongs to a removal that has not happened yet; an archive must not
    // take it, or that removal would settle from a live server instead of the
    // frozen list it was taken for. Unlike a removal, the archive keeps the
    // verdicts it just read: they are the run facts that make a snapshot a review.
    snapshotForArchive: ({ worktreeId, hostId, now }) => {
      const collected = collectWorktreeSessions(deps, worktreeId, now)
      return {
        // No store set ⇒ nothing was measured, and an absent figure is the only true
        // statement. The archive write then stores no settlement rather than a reason
        // for a measurement that never happened.
        settlement: deps.stores ? settlementFor(worktreeId, hostId, now) : null,
        sessions: collected.sessions,
        ...(collected.outcomes.size === 0 ? {} : { outcomes: collected.outcomes })
      }
    },
    ...(deps.archiveSnapshot ? { archiveSnapshot: deps.archiveSnapshot } : {})
  }
}

function readProviderRows(
  stores: TaskRecordsUsageStoreSet,
  worktreeId: string
): TaskUsageSettlementProvider[] {
  const key = `worktree:${worktreeId}`
  const rows: TaskUsageSettlementProvider[] = []
  const claude = stores.claude
    .getSnapshot('orca', 'all')
    .projectBreakdown.find((row) => row.key === key)
  if (claude) {
    rows.push({
      provider: 'claude',
      tokens:
        claude.inputTokens + claude.outputTokens + claude.cacheReadTokens + claude.cacheWriteTokens,
      costUsd: claude.estimatedCostUsd
    })
  }
  const codex = stores.codex
    .getSnapshot('orca', 'all')
    .projectBreakdown.find((row) => row.key === key)
  if (codex) {
    rows.push({ provider: 'codex', tokens: codex.totalTokens, costUsd: codex.estimatedCostUsd })
  }
  const opencode = stores.opencode
    .getSnapshot('orca', 'all')
    .projectBreakdown.find((row) => row.key === key)
  if (opencode) {
    rows.push({
      provider: 'opencode',
      tokens: opencode.totalTokens,
      costUsd: opencode.estimatedCostUsd
    })
  }
  const muse = stores.muse
    .getSnapshot('orca', 'all')
    .projectBreakdown.find((row) => row.key === key)
  if (muse) {
    // Muse publishes no cost at all: null (unpriced), never `$0`.
    rows.push({ provider: 'muse', tokens: muse.totalTokens, costUsd: null })
  }
  return rows
}

function anyProviderEnabled(stores: TaskRecordsUsageStoreSet): boolean {
  return (
    stores.claude.getScanState().enabled ||
    stores.codex.getScanState().enabled ||
    stores.opencode.getScanState().enabled ||
    stores.muse.getScanState().enabled
  )
}

/**
 * The three answers the settlement has, in the order they must be decided: not
 * measured at all (scanning off), measured somewhere it cannot be read (a remote
 * host's usage cache is not this host's), measured and found nothing, measured.
 * A fourth arm would be "measured and zero", which is a known figure, not an
 * absence — that is why `known` carries the provider rows and not a bare total.
 */
export function buildTaskUsageSettlement(args: {
  worktreeId: string
  hostId: ExecutionHostId
  now: number
  providers: readonly TaskUsageSettlementProvider[]
  enabled: boolean
}): TaskUsageSettlement {
  const base = {
    collectedAt: args.now,
    scope: 'worktree-rollup' as const,
    worktreeId: args.worktreeId
  }
  if (!args.enabled) {
    return { kind: 'unavailable', ...base, reason: 'usage_not_enabled' }
  }
  if (args.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return { kind: 'unavailable', ...base, reason: 'remote_usage_unavailable' }
  }
  if (args.providers.length === 0) {
    return { kind: 'unavailable', ...base, reason: 'no_matching_session' }
  }
  const unpriced = args.providers.some((row) => row.costUsd === null)
  return {
    kind: 'known',
    ...base,
    providers: [...args.providers],
    // One unpriced provider makes the task total unknown, not partially priced:
    // a sum that silently skips a provider under-reports real spend.
    estimatedCostUsd: unpriced
      ? null
      : args.providers.reduce((total, row) => total + (row.costUsd ?? 0), 0)
  }
}

/** What one collection of the hook server yields: the session rows, and the verdicts
 *  the *same* rows recorded, keyed by the run claim. Two row kinds, one identity. */
type CollectedWorktreeSessions = {
  sessions: TaskRecordSession[]
  outcomes: Map<string, AgentJournalTurnOutcome>
}

function collectWorktreeSessions(
  deps: TaskRecordsUsageSourceDeps,
  worktreeId: string,
  now: number
): CollectedWorktreeSessions {
  const sessions: TaskRecordSession[] = []
  const outcomes = new Map<string, AgentJournalTurnOutcome>()
  for (const identity of deps.sessionIdentities()) {
    // No key means no way to say which field the id came from; a guess would be
    // indistinguishable from a reported value, so the session is not recorded.
    if (identity.worktreeId !== worktreeId || !identity.sessionId || !identity.key) {
      continue
    }
    const provider = deps.providerForPaneKey(identity.paneKey)
    const providerSession = {
      ...(provider ? { provider } : {}),
      key: identity.key,
      id: identity.sessionId
    }
    // The run row's own claim function, so the two lists cannot disagree about who
    // ran; a verdict the session cannot carry travels under that key instead.
    if (identity.outcome !== undefined) {
      outcomes.set(taskRecordRunClaimKey(providerSession), identity.outcome)
    }
    sessions.push({
      ...providerSession,
      ...(identity.transcriptPath ? { transcriptPath: identity.transcriptPath } : {}),
      // Snapshot facts the hook status row states (issue #53 §4). Absent stays
      // absent: a stored `0` or an epoch start would be read as a measurement.
      ...(identity.agentType === undefined ? {} : { agentType: identity.agentType }),
      ...(identity.title === undefined ? {} : { title: identity.title }),
      ...(identity.startedAt === undefined ? {} : { startedAt: identity.startedAt }),
      ...(identity.endedAt === undefined ? {} : { endedAt: identity.endedAt }),
      ...(identity.messageCount === undefined ? {} : { messageCount: identity.messageCount }),
      firstSeenAt: now,
      lastSeenAt: now
    })
  }
  return { sessions, outcomes }
}
