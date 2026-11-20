import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type {
  TaskRecordSession,
  TaskRecordsRemovalSnapshot,
  TaskRecordUsageProvider,
  TaskUsageSettlement,
  TaskUsageSettlementProvider
} from '../../shared/task-records-types'

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

/** One provider session the hook server currently knows. `key` is absent when
 *  the reporting provider only gave an id. */
export type TaskRecordSessionIdentity = {
  paneKey: string
  sessionId: string
  key?: string
  transcriptPath?: string
  worktreeId?: string
}

export type TaskRecordsUsageSourceDeps = {
  stores: TaskRecordsUsageStoreSet
  /** Hook-server snapshot; a session the server no longer knows cannot be listed. */
  sessionIdentities: () => readonly TaskRecordSessionIdentity[]
  /** Which usage provider a pane's agent is, when the tab pins one. */
  providerForPaneKey: (paneKey: string) => TaskRecordUsageProvider | undefined
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
      sessions: collectWorktreeSessions(deps, worktreeId, now)
    })
  }
  const sessionsForRemoval = (worktreeId: string, now: number): TaskRecordSession[] => {
    const captured = capturedSessions.get(worktreeId)
    if (!captured) {
      return collectWorktreeSessions(deps, worktreeId, now)
    }
    // Consumed once: a second removal of a re-created locator must read the live
    // hook server again, not inherit a dead occupant's sessions.
    capturedSessions.delete(worktreeId)
    // A capture that outlived its TTL was not consumed by the removal it was
    // taken for; it is not evidence for a later one, so read the live server.
    if (now - captured.capturedAt > REMOVAL_SESSION_CAPTURE_TTL_MS) {
      return collectWorktreeSessions(deps, worktreeId, now)
    }
    return captured.sessions
  }
  return {
    captureSessionsForRemoval,
    snapshotForRemoval: ({ worktreeId, hostId, now }) => ({
      settlement: buildTaskUsageSettlement({
        worktreeId,
        hostId,
        now,
        providers: readProviderRows(deps.stores, worktreeId),
        enabled: anyProviderEnabled(deps.stores)
      }),
      sessions: sessionsForRemoval(worktreeId, now)
    })
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

function collectWorktreeSessions(
  deps: TaskRecordsUsageSourceDeps,
  worktreeId: string,
  now: number
): TaskRecordSession[] {
  const sessions: TaskRecordSession[] = []
  for (const identity of deps.sessionIdentities()) {
    // No key means no way to say which field the id came from; a guess would be
    // indistinguishable from a reported value, so the session is not recorded.
    if (identity.worktreeId !== worktreeId || !identity.sessionId || !identity.key) {
      continue
    }
    const provider = deps.providerForPaneKey(identity.paneKey)
    sessions.push({
      ...(provider ? { provider } : {}),
      key: identity.key,
      id: identity.sessionId,
      ...(identity.transcriptPath ? { transcriptPath: identity.transcriptPath } : {}),
      firstSeenAt: now,
      lastSeenAt: now
    })
  }
  return sessions
}
