import {
  taskRecordRunClaimKey,
  type TaskRecord,
  type TaskRecordGap,
  type TaskRecordRun,
  type TaskRecordSession,
  type TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import type {
  TaskWorkbenchGapView,
  TaskWorkbenchHistory,
  TaskWorkbenchHistoryRun,
  TaskWorkbenchHistorySession,
  TaskWorkbenchHistoryWorkspace
} from '@/components/task-workbench/task-workbench-view'
import { taskHistoryWallClock } from './task-workbench-join'
import { aggregateSettlement, settleTokens } from './task-workbench-history-settlement'

/**
 * Fold the persisted task record into the join's history (issue #36).
 *
 * The join only sees workspaces that still exist. The record is what survives a
 * deletion: the binding set, the sessions those workspaces reported, and the
 * usage figure settled before the checkout stopped being readable.
 *
 * Three rules, each of which the tests pin separately:
 * - a binding the store still knows is *not* history; presence is decided by the
 *   caller's workspace list, never by the record, so a live workspace cannot be
 *   mislabelled `Removed`;
 * - an absent settled figure stays absent (an unavailable reason), never `0`;
 * - a task with no live workspace but a record states the deleted form instead of
 *   falling back to "never started".
 *
 * A live workspace is not a row source of its own, with one exception: the run
 * observations the record already holds (a `live-observation` written while the
 * agent ran). A pane that was closed mid-task is no longer in the projection, so
 * without that fold its row would vanish even though the task really ran it;
 * every row the live projection does print wins, so nothing is listed twice.
 *
 * Since issue #53 the record also carries the runs behind those sessions, so an
 * archived binding states its agent rows (agent type, wall clock, message count)
 * and a deleted one still lists them. `historySource` says which rows a reader is
 * looking at, because a frozen observation and a live projection are different
 * evidence — the panel prints that difference instead of hiding it.
 *
 * A run list is not the whole record: `gaps` carries the absences the writer
 * stored ("nobody could tell which agent ran here") so a workspace with no rows
 * never renders as a workspace that never ran. */
export function mergeTaskRecordHistory(args: {
  history: TaskWorkbenchHistory
  /** Every worktree id the store still has for this repository, archived ones
   *  included. Deliberately not the task's matched set: a workspace re-linked to
   *  another task still exists, and calling it `Removed` would be a lie. */
  existingWorktreeIds: readonly string[]
  record: TaskRecord | null
  /** The `<key>:<id>` ids of the sessions the live projection already prints. A
   *  record run with one of those ids is the same session observed twice, so it
   *  is not listed again — see `claimIdentityOf` for which side wins and why the
   *  id alone is enough. */
  liveRunSessionIds?: readonly string[]
}): TaskWorkbenchHistory {
  const record = args.record
  if (!record) {
    return args.history
  }
  const live = new Set(args.existingWorktreeIds)
  const removedBindings = record.bindings.filter((binding) => !live.has(binding.worktreeId))
  const archivedBindings = record.bindings.filter(
    (binding) => live.has(binding.worktreeId) && binding.isArchived
  )
  // A live workspace whose record already holds observations: an agent whose TUI
  // was closed mid-task is no longer a pane, so the live projection cannot speak
  // for it, but the observation written while it ran can (issue #53 follow-up).
  // `runs` only, never the session fallback: a live binding's sessions are the
  // removal reader's rows, and the pane projection already covers what is open.
  const liveBindingsWithRuns = record.bindings.filter(
    (binding) =>
      live.has(binding.worktreeId) && !binding.isArchived && (binding.runs?.length ?? 0) > 0
  )
  const claimed = new Set(args.liveRunSessionIds ?? [])
  const recordedRuns = [
    // An archived workspace is still on this machine, so its recorded runs are
    // resumable; a removed one is not, and the row must say so instead of
    // offering an action that would fail (issue #53 A2).
    ...[...archivedBindings, ...removedBindings].flatMap((binding) =>
      recordRunsOf(binding, live.has(binding.worktreeId))
    ),
    ...liveBindingsWithRuns.flatMap((binding) => recordRunsOf(binding, true))
  ]
  // A run the live projection already prints is the same session observed twice,
  // so only the rows the panes cannot speak for are added. This is also what lets
  // the early return below stay honest: a record whose every row is already on
  // screen changes nothing, and the panel must not re-render for it.
  const fromRecord = recordedRuns.filter((run) => !claimed.has(claimIdentityOf(run.key)))
  // Nothing left the store, nothing is put away, and no closed run to add: the
  // join's answer is already complete, and returning the same object keeps the
  // panel from re-rendering on every record read.
  if (removedBindings.length === 0 && archivedBindings.length === 0 && fromRecord.length === 0) {
    return args.history
  }
  const workspaces: TaskWorkbenchHistoryWorkspace[] = [
    ...archivedBindings.map((binding) => ({
      worktreeId: binding.worktreeId,
      path: binding.path,
      state: 'archived' as const,
      lastVerifiedAt: binding.lastVerifiedAt,
      hasSessions: binding.sessions.length > 0
    })),
    ...removedBindings.map((binding) => ({
      worktreeId: binding.worktreeId,
      path: binding.path,
      state: 'removed' as const,
      lastVerifiedAt: binding.lastVerifiedAt,
      hasSessions: binding.sessions.length > 0
    }))
  ]
  const sessions = removedBindings.flatMap((binding) =>
    binding.sessions.map((session): TaskWorkbenchHistorySession => ({
      key: sessionKeyOf(session),
      ...(session.provider ? { provider: session.provider } : {}),
      hasTranscriptPath: session.transcriptPath !== undefined,
      // The path is the `locate trace` target; the stored check is the only
      // evidence about it, and an absent check stays absent (a pointer is not a
      // claim that the file is there).
      ...(session.transcriptPath === undefined ? {} : { transcriptPath: session.transcriptPath }),
      ...(session.transcriptCheck === undefined
        ? {}
        : {
            trace: {
              presence: session.transcriptCheck.presence,
              checkedAt: session.transcriptCheck.checkedAt
            }
          }),
      // Resume needs the checkout the session ran in; with the binding removed
      // there is nothing to resume into, so the panel must say so instead of
      // offering an action that cannot work.
      resumable: false,
      worktreeId: binding.worktreeId
    }))
  )
  const settled = aggregateSettlement(
    // Archived and removed: a settlement is a *workspace* figure the record froze,
    // so it belongs to the task total once, whether or not the checkout is still
    // on this machine (S11). Counting the per-row rollups instead left an
    // archive+restart task at "tokens unknown" although the record held a
    // measured figure, and the row figures are only a split of this same total.
    [...archivedBindings, ...removedBindings].map((binding) => binding.usageSettlement)
  )
  const noLiveWorkspace = record.bindings.every((binding) => !live.has(binding.worktreeId))
  const tokens = settleTokens(args.history.tokens, settled, noLiveWorkspace)
  // Archived and removed rows carry their binding's gaps; a live binding has none
  // to add (its own rows are on screen, and a gap is a statement about a workspace
  // that stopped being readable).
  const foldable = [...archivedBindings, ...removedBindings]
  const runs = [...args.history.runs, ...fromRecord]
  const gaps = recordGapsOf(foldable)
  // `record` only when the whole list is the record's; a list holding both kinds
  // says `mixed`, because one badge over live rows would claim they are frozen
  // observations (S7).
  const historySource =
    fromRecord.length === 0
      ? (args.history.historySource ?? 'live')
      : args.history.runs.length === 0
        ? 'record'
        : 'mixed'

  const merged: TaskWorkbenchHistory = {
    ...args.history,
    tokens,
    tokensSource: settled !== null ? 'settled' : args.history.tokensSource,
    archivedWorkspaces: archivedBindings.length,
    deletedWorkspaces: removedBindings.length,
    workspaces,
    sessions,
    runs,
    gaps,
    historySource,
    lastActivityAt: latestActivity(
      args.history.lastActivityAt,
      workspaces,
      sessions.length + runs.length > 0,
      record
    ),
    // A record row the live projection could not state is a row the count and
    // the window must cover: a facts line that disagreed with the list under it
    // would be a second answer to the same question.
    ...(fromRecord.length === 0 ? {} : { agents: runs.length, wall: taskHistoryWallClock(runs) }),
    // A removed binding outranks an archived one; an archived binding still has
    // content on this machine, which is what the strip's archive form states.
    trace:
      removedBindings.length > 0
        ? 'deleted'
        : archivedBindings.length > 0
          ? 'archived'
          : args.history.trace
  }
  if (removedBindings.length === 0) {
    return merged
  }
  // No workspace row is left to read the live facts from, so they stay unknown
  // rather than being inherited from whatever the join happened to see. The
  // recorded rows below are observations, not a live count.
  return noLiveWorkspace ? { ...merged, agents: null, wall: { kind: 'unknown' } } : merged
}

/** The `key:id` half of a claim. The live projection knows the id but not which
 *  usage provider the pane belongs to (that lives in main's launch metadata), so
 *  the duplicate check compares the half both sides can spell. The record still
 *  keeps two providers' claims apart; this rule only decides which of two rows
 *  describing one id is printed, and the live row wins. */
function claimIdentityOf(claim: string): string {
  const separator = claim.indexOf('|')
  return separator === -1 ? claim : claim.slice(separator + 1)
}

/** One recorded run as the history strip renders it. Absent facts stay absent: a
 *  row with no measured window prints `—` rather than the epoch, and a row with
 *  no recorded name prints its claim rather than an invented title. */
function historyRunOf(
  run: TaskRecordRun,
  resumable: boolean,
  checkoutPath: string
): TaskWorkbenchHistoryRun {
  return {
    key: run.key,
    ...(run.title === undefined ? {} : { title: run.title }),
    ...(run.agentType === undefined ? {} : { agentType: run.agentType }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.messageCount === undefined ? {} : { messageCount: run.messageCount }),
    ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
    ...(run.transcriptPath === undefined ? {} : { transcriptPath: run.transcriptPath }),
    ...(run.transcriptCheck === undefined
      ? {}
      : {
          trace: {
            presence: run.transcriptCheck.presence,
            checkedAt: run.transcriptCheck.checkedAt
          }
        }),
    ...(run.resumeCommand === undefined ? {} : { resumeCommand: run.resumeCommand }),
    resumable,
    ...(checkoutPath === '' ? {} : { checkoutPath }),
    fromRecord: true
  }
}

/** A binding's rows: its recorded runs, or — when no build ever recorded runs —
 *  rows derived from the sessions it does have (S6).
 *
 *  Absent `runs` is not `[]`: absent means a v1 binding (or a record written
 *  before the run channel existed) that still reports sessions. Leaving those
 *  out made a workspace that really ran render no agent row at all, which is the
 *  "archived but silent" case the issue was filed for. The derived row states
 *  what the session states and nothing more: a v1 session has no facts, so its
 *  row prints the claim and an unknown wall clock. */
function recordRunsOf(
  binding: TaskWorkspaceBinding,
  resumable: boolean
): TaskWorkbenchHistoryRun[] {
  if (binding.runs !== undefined) {
    return binding.runs.map((run) => historyRunOf(run, resumable, binding.path))
  }
  return binding.sessions.map((session) => ({
    // The claim, spelled exactly as the merge identity spells it, so a live row
    // for the same session dedupes against it.
    key: taskRecordRunClaimKey(session),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.agentType === undefined ? {} : { agentType: session.agentType }),
    ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
    ...(session.messageCount === undefined ? {} : { messageCount: session.messageCount }),
    ...(session.transcriptPath === undefined ? {} : { transcriptPath: session.transcriptPath }),
    ...(session.transcriptCheck === undefined
      ? {}
      : {
          trace: {
            presence: session.transcriptCheck.presence,
            checkedAt: session.transcriptCheck.checkedAt
          }
        }),
    ...(session.resumeCommand === undefined ? {} : { resumeCommand: session.resumeCommand }),
    resumable,
    ...(binding.path === '' ? {} : { checkoutPath: binding.path }),
    fromRecord: true
  }))
}

/** The absences of every workspace the fold covers, binding-level and per-run.
 *
 *  Two states must not read as one (coordinated with seat B's S5 fix): a gap on a
 *  workspace that has **no** rows is the whole state — "no agent could be
 *  attributed here", the sentence T2 asks for — while a gap on a workspace whose
 *  rows arrived later is provenance: the archive moment could not attribute from
 *  the pane side, and the session index supplied the rows afterwards. Both are
 *  kept; `standalone` says which one the panel is printing.
 *
 *  Identity is `kind|detail|standalone` — the first two are the pair the record
 *  unions gaps on, and the third keeps the two readings of one stored absence from
 *  collapsing into each other. */
function recordGapsOf(bindings: readonly TaskWorkspaceBinding[]): TaskWorkbenchGapView[] {
  const gaps: TaskWorkbenchGapView[] = []
  const seen = new Set<string>()
  const add = (gap: TaskRecordGap, standalone: boolean): void => {
    const identity = `${gap.kind}|${gap.detail ?? ''}|${standalone}`
    if (seen.has(identity)) {
      return
    }
    seen.add(identity)
    gaps.push({
      kind: gap.kind,
      ...(gap.candidateCount === undefined ? {} : { candidateCount: gap.candidateCount }),
      ...(gap.detail === undefined ? {} : { detail: gap.detail }),
      standalone
    })
  }
  for (const binding of bindings) {
    // `runs: []` is a writer that looked and found none; absent `runs` falls back
    // to the sessions, which is also what the rows are derived from.
    const rowCount = (binding.runs ?? binding.sessions).length
    for (const gap of binding.gaps ?? []) {
      add(gap, rowCount === 0)
    }
    for (const run of binding.runs ?? []) {
      // A run-level gap is a statement about a row that exists, so it is never
      // the "nothing to attribute" state.
      for (const gap of run.gaps ?? []) {
        add(gap, false)
      }
    }
  }
  return gaps
}

/** Includes the provider: the record deliberately keeps both claims when two
 *  providers each report one id, and this key is a React list key. */
function sessionKeyOf(session: TaskRecordSession): string {
  return `${session.provider ?? 'unknown'}|${session.key}:${session.id}`
}

function latestActivity(
  current: number | undefined,
  workspaces: readonly TaskWorkbenchHistoryWorkspace[],
  hasRows: boolean,
  record: TaskRecord
): number | undefined {
  let latest = current
  for (const workspace of workspaces) {
    if (workspace.lastVerifiedAt === null) {
      continue
    }
    latest = Math.max(latest ?? Number.NEGATIVE_INFINITY, workspace.lastVerifiedAt)
  }
  if (hasRows) {
    latest = Math.max(latest ?? Number.NEGATIVE_INFINITY, record.updatedAt)
  }
  return latest
}
