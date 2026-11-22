import {
  TASK_RECORD_RUNS_SCHEMA_VERSION,
  TASK_RECORD_SCHEMA_VERSION,
  type TaskWorkspaceBinding
} from './task-records-types'

/**
 * Which `schemaVersion` a write that changed `binding` has to leave on its
 * record.
 *
 * The version is raised by the **content** of the write, never by the call site:
 * a metadata refresh that stored nothing new must not make a downgrade lose a
 * whole domain for nothing, and a write that did store a new generation's fact
 * must make an older build refuse the domain verbatim instead of rebuilding the
 * record without the rows it cannot read.
 *
 * Two generations are recognised, each by the channels that arrived with it:
 * - `TASK_RECORD_RUNS_SCHEMA_VERSION` (v2): `runs` / `gaps` exist, or a session
 *   row carries any of the snapshot fields.
 * - `TASK_RECORD_SCHEMA_VERSION` (v3): a stored run says it was observed while it
 *   ran (`source: 'live-observation'`), a value a v2 build would drop.
 */

/** True when the binding now holds something a build that only knows v1 could
 *  not read back.
 *
 *  Every v2 channel counts, and `runs !== undefined` counts **including `runs: []`**:
 *  an empty array is the T2 statement "the snapshot writer looked and stored no
 *  run, here is the gap that says why", which a v1 build cannot read as anything
 *  but "unknown". Missing it let a T2 backfill store `runs`/`gaps` on a record
 *  still labelled v1. */
function carriesV2Facts(binding: TaskWorkspaceBinding): boolean {
  if (binding.runs !== undefined) {
    return true
  }
  if ((binding.gaps?.length ?? 0) > 0) {
    return true
  }
  return binding.sessions.some(
    (session) =>
      session.agentType !== undefined ||
      session.title !== undefined ||
      session.resumeCommand !== undefined ||
      session.startedAt !== undefined ||
      session.endedAt !== undefined ||
      session.messageCount !== undefined ||
      session.source !== undefined ||
      session.recordedAt !== undefined ||
      session.transcriptCheck !== undefined
  )
}

/** True when the binding holds a run a build that only knows v2 could not read
 *  back: the `live-observation` source value arrived with v3, and a v2 build
 *  would drop that row (and then save the record without it). */
function carriesLiveObservationFacts(binding: TaskWorkspaceBinding): boolean {
  return (binding.runs ?? []).some((run) => run.source === 'live-observation')
}

export function taskRecordSchemaVersionForBinding(
  binding: TaskWorkspaceBinding,
  storedVersion: number
): number {
  if (carriesLiveObservationFacts(binding)) {
    return Math.max(storedVersion, TASK_RECORD_SCHEMA_VERSION)
  }
  if (carriesV2Facts(binding)) {
    return Math.max(storedVersion, TASK_RECORD_RUNS_SCHEMA_VERSION)
  }
  return storedVersion
}
