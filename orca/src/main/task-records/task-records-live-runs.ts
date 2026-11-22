import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  taskRecordRunClaimKey,
  type TaskRecordRun,
  type TaskRecordsState,
  type TaskRecordUsageProvider
} from '../../shared/task-records-types'
import { mergeTaskRecordRuns } from '../../shared/task-records-updates'
import { hookSessionFacts, type HookAgentStatusFacts } from './task-records-worktree-usage'

/**
 * The live run observation: a run written into the task record **while the agent
 * is still running**, so a TUI that is closed — or a process that dies — mid-task
 * keeps its row.
 *
 * Why it exists: the archive snapshot reads the hook server's pane attribution at
 * the archive instant, and a closed pane is already gone from that server. The
 * asynchronous fallback (session index by path + window) can only answer when the
 * window holds exactly one session, which is the normal case in a solo workspace
 * and the exception in a swarm where several agents share one checkout. So the
 * only observation that can still answer "who ran here" after the pane is gone is
 * the one taken before it went away.
 *
 * What it is not: a second writer of live UI state. The row is the same fact
 * shape the archive snapshot stores, keyed by the same claim, and it participates
 * in no active / needs-you / badge counting. A later archive snapshot upserts
 * over it by claim; provenance is first-writer-wins, so the row keeps saying
 * `live-observation` (it was observed then, and re-labelling it as an
 * archive-snapshot would claim a freeze that happened later).
 *
 * Facts come from the hook status row through `hookSessionFacts`, the same
 * function the archive path uses, so the two paths cannot disagree about what a
 * `done` row means. Absent stays absent: no message count, no title, no verdict
 * for a plain Stop.
 */

/** The status-row facts this module reads. Structural on purpose: the hook
 *  server's enriched payload satisfies it, and a test can pass one object
 *  instead of an IPC event with thirty fields. */
export type LiveAgentStatusRow = {
  /** Which workspace the pane was attributed to. A row without one cannot name a
   *  binding, so it is not an observation this module can store. */
  worktreeId?: string
  providerSession?: { key?: string; id: string; transcriptPath?: string }
} & HookAgentStatusFacts

/** One run, and the workspace whose binding it belongs to. */
export type LiveRunObservation = {
  worktreeId: string
  run: TaskRecordRun
}

/** The status row as a run row, or `null` when the row cannot be attributed to a
 *  binding. Nothing is guessed: no claim, no worktree or no provider-session key
 *  means the row is not storable, and a storable row is never invented from a
 *  prompt (a prompt is content, not a title).
 *
 *  `provider` is the usage bucket the pane's launch agent maps to (or `undefined`
 *  for an agent this build has no usage store for); it is the same value the
 *  archive path derives from the pane, so the two rows share one claim. */
export function liveRunObservation(args: {
  row: LiveAgentStatusRow
  provider?: TaskRecordUsageProvider
  now: number
}): LiveRunObservation | null {
  const { row, provider, now } = args
  const worktreeId = row.worktreeId
  const sessionId = row.providerSession?.id
  const key = row.providerSession?.key
  if (!worktreeId || !sessionId || !key) {
    return null
  }
  const providerSession = {
    ...(provider ? { provider } : {}),
    key,
    id: sessionId
  }
  const facts = hookSessionFacts(row)
  const transcriptPath = row.providerSession?.transcriptPath
  return {
    worktreeId,
    run: {
      key: taskRecordRunClaimKey(providerSession),
      providerSession,
      ...(facts.agentType === undefined ? {} : { agentType: facts.agentType }),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(facts.startedAt === undefined ? {} : { startedAt: facts.startedAt }),
      ...(facts.endedAt === undefined ? {} : { endedAt: facts.endedAt }),
      // A verdict outside the shared vocabulary never reaches this path (the
      // predicate reads the shared type), but an absent one stays absent: a plain
      // Stop is unknown, never a success.
      ...(facts.outcome === undefined ? {} : { outcome: facts.outcome }),
      source: 'live-observation',
      recordedAt: now,
      firstSeenAt: now,
      lastSeenAt: now
    }
  }
}

/** Everything about a row except its observation clock: two hook events that
 *  state the same facts are one row, and the store must not be saved for the
 *  second one. The hook feed publishes per event (tool use, prompts, state), so
 *  without this key every event would write. */
export function liveRunFactsKey(observation: LiveRunObservation): string {
  const run = observation.run
  return JSON.stringify([
    observation.worktreeId,
    run.key,
    run.title ?? null,
    run.agentType ?? null,
    run.resumeCommand ?? null,
    run.startedAt ?? null,
    run.endedAt ?? null,
    run.messageCount ?? null,
    run.outcome ?? null,
    run.transcriptPath ?? null
  ])
}

/** The bindings this observation can reach, indexed once per state object.
 *  Rebuilt whenever the domain object changes (any write), so a hook event does
 *  not scan every record of the profile. */
const bindingsByWorktree = new WeakMap<TaskRecordsState, Map<string, BindingOwner[]>>()

type BindingOwner = { taskId: string; hostId: string }

function ownerIndex(state: TaskRecordsState): Map<string, BindingOwner[]> {
  const cached = bindingsByWorktree.get(state)
  if (cached) {
    return cached
  }
  const index = new Map<string, BindingOwner[]>()
  for (const record of Object.values(state.byId)) {
    for (const binding of record.bindings) {
      const bucket = index.get(binding.worktreeId)
      const owner = { taskId: record.taskId, hostId: binding.hostId }
      if (bucket) {
        bucket.push(owner)
      } else {
        index.set(binding.worktreeId, [owner])
      }
    }
  }
  bindingsByWorktree.set(state, index)
  return index
}

/**
 * Write one observation into every task that binds this workspace.
 *
 * A worktree can belong to more than one task (the GitHub issue and its PR each
 * carry a link), which is why the write fans out instead of picking a record.
 * The remote case is deliberately not written: a remote host's binding is settled
 * as `remote_usage_unavailable` and its transcripts are not on this host, so an
 * observation taken here cannot claim to describe it — the run row would be a
 * local fact stored under another host's owner.
 *
 * Over the per-binding cap `mergeTaskRecordRuns` refuses the whole call; that is
 * reported and the stored state is left alone, never truncated.
 */
export function recordLiveRunObservation(
  state: TaskRecordsState,
  observation: LiveRunObservation,
  now: number
): { state: TaskRecordsState; changed: boolean } {
  const owners = ownerIndex(state).get(observation.worktreeId) ?? []
  let current = state
  let changed = false
  for (const owner of owners) {
    if (owner.hostId !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const result = mergeTaskRecordRuns(current, {
      taskId: owner.taskId,
      worktreeId: observation.worktreeId,
      hostId: owner.hostId,
      runs: [observation.run],
      now
    })
    if (!result.ok) {
      console.error(
        `[task-records] live run observation refused for ${observation.worktreeId}: ${result.reason}`
      )
      continue
    }
    if (result.changed) {
      current = result.state
      changed = true
    }
  }
  return { state: current, changed }
}

/** The observer the main process wires to the hook feed. It keeps the last
 *  written fact key per claim so a status ping that states nothing new never
 *  touches the store, and hands the write to the caller (the Store owns the
 *  schedule, exactly as it does for every other task-record write). */
export function createTaskRecordsLiveRunObserver(args: {
  providerForPaneKey: (paneKey: string) => TaskRecordUsageProvider | undefined
  record: (observation: LiveRunObservation, now: number) => void
  now?: () => number
}): { observe: (row: LiveAgentStatusRow) => void } {
  const written = new Map<string, string>()
  return {
    observe: (row) => {
      const at = args.now?.() ?? Date.now()
      const observation = liveRunObservation({
        row,
        provider: args.providerForPaneKey(row.paneKey),
        now: at
      })
      if (!observation) {
        return
      }
      const cacheKey = `${observation.worktreeId}|${observation.run.key}`
      const facts = liveRunFactsKey(observation)
      if (written.get(cacheKey) === facts) {
        return
      }
      args.record(observation, at)
      // Bounded on purpose: a long-lived app can see thousands of agent runs, and
      // forgetting one key only costs a merge that finds nothing new.
      if (written.size >= LIVE_RUN_OBSERVATION_CACHE_LIMIT) {
        written.clear()
      }
      written.set(cacheKey, facts)
    }
  }
}

/** Five hundred entries is far more than one page ever shows; the map is a write
 *  filter, not a history. */
const LIVE_RUN_OBSERVATION_CACHE_LIMIT = 512
