import {
  TASK_RECORDS_MAX_RUNS_PER_BINDING,
  TASK_RECORDS_MAX_SESSIONS_PER_BINDING,
  taskRecordRunClaimKey,
  type TaskRecordGap,
  type TaskRecordRun,
  type TaskRecordSession,
  type TaskRecordTranscriptCheck
} from './task-records-types'
import { taskRecordTranscriptCheckShape } from './task-records-runs-transcript'

/**
 * Merging the two observation rows this domain stores: `sessions` (v1) and
 * `runs`/`gaps` (v2, issue #53). Split from `task-records-updates.ts` to stay
 * inside the `max-lines` budget, and kept pure (no record lookup, no bounds) so
 * the state transitions there can keep going through one `grown()`.
 *
 * ## The precedence rule, which every row kind follows
 *
 * - **Identity is the claim, never the row's contents**: `provider|key:id`. Two
 *   observations of one session are one row, which is why replaying a snapshot
 *   or running a backfill twice cannot duplicate anything.
 * - **`firstSeenAt` = min, `lastSeenAt` = max** (issue #53 A6: the window is the
 *   union of every observation). These two are the only fields that merge
 *   symmetrically; they are the claim's observation window, not the run's
 *   measured wall clock (`startedAt`/`endedAt`).
 * - **A fact is taken only from an observation that is not older than the stored
 *   one** — `title`, `agentType`, `resumeCommand`, `startedAt`, `endedAt`,
 *   `messageCount`, `outcome`, `transcriptPath`, and a gap's `candidateCount`.
 *   "Older" is `recordedAt`, falling back to `lastSeenAt` for a row that has none
 *   (a v1 session). A newer observation wins because it saw more — a run's
 *   `endedAt` and `messageCount` are only final once it ended — and a replay that
 *   carries an **older** observation contributes nothing but the window. Without
 *   that guard the rule would be "the last caller wins", and a stale replay could
 *   put t1 facts on a row whose provenance is t2 (the replay is the normal case
 *   for seats B/C, so call order cannot be the contract).
 * - **Equal `recordedAt`: the incoming observation wins.** The record has no finer
 *   clock, so two same-millisecond observations are equally new and the later call
 *   is the only tie-break there is; an identical replay is still `changed: false`
 *   because it states the same facts.
 * - **An absent fact never erases a stored one.** Not knowing a value now is not
 *   evidence that the stored value is wrong, so a re-observation that could not
 *   measure `endedAt` leaves the measured edge alone (and a stale one does not
 *   touch it either).
 * - **Provenance is first-writer-wins** (`source`, `recordedAt`, and a gap's
 *   `observedAt`). A later observation may *fill* a provenance field the row
 *   does not have yet, but never rewrites one. Why: those fields exist so a
 *   reader can weigh a row ("frozen at the irreversible moment" vs
 *   "reconstructed later"), and letting a later backfill relabel an
 *   archive-snapshot row as `backfill` would lose exactly that information. It is
 *   also what makes an identical replay a true no-op (`{ changed: false }`): a
 *   replay states no new provenance, so nothing about the row moves.
 * - **`transcriptCheck` is a measurement, not provenance, so the newest `checkedAt`
 *   wins** — and it wins as a *whole check*: `dev`/`ino`/`mtimeMs`/`size` describe
 *   one `stat` of one file, so mixing `size` from one stat with `mtimeMs` of
 *   another would store a measurement nobody took. On an equal `checkedAt` the
 *   **stored check is kept** (first writer at that instant wins): the two claims
 *   are equally new, and a fixed tie-break is what keeps an identical replay
 *   `changed: false` and stops two same-instant writers from flipping the value.
 *   Note this is the opposite direction from `source`/`recordedAt` on purpose:
 *   provenance answers "who recorded this row", so the first writer owns it;
 *   `transcriptCheck` answers "what did the file look like then", so the freshest
 *   look owns it. Do not copy one rule onto the other.
 * - **Gaps are unioned by `kind|detail`**, so a repeated snapshot reports the
 *   same absence once instead of stacking a new row per attempt.
 */

export type TaskRecordSessionMerge =
  | { changed: false; dropped: number }
  | { changed: true; sessions: TaskRecordSession[]; dropped: number }

/** Upsert `incoming` into `existing` by claim. Over the per-binding cap the
 *  extra rows are counted and skipped (`dropped`), which is the behaviour issue
 *  #36 shipped for sessions; runs refuse instead (see `mergeRunRows`). */
export function mergeSessionRows(
  existing: readonly TaskRecordSession[],
  incoming: readonly TaskRecordSession[]
): TaskRecordSessionMerge {
  const rows = [...existing]
  let changed = false
  let dropped = 0
  for (const observation of incoming) {
    const claim = taskRecordRunClaimKey(observation)
    const index = rows.findIndex((row) => taskRecordRunClaimKey(row) === claim)
    if (index === -1) {
      if (rows.length >= TASK_RECORDS_MAX_SESSIONS_PER_BINDING) {
        dropped += 1
        continue
      }
      rows.push(observation)
      changed = true
      continue
    }
    const merged = mergeSessionObservation(rows[index], observation)
    if (merged === null) {
      continue
    }
    rows[index] = merged
    changed = true
  }
  return changed ? { changed: true, sessions: rows, dropped } : { changed: false, dropped }
}

export type TaskRecordRunMerge =
  /** The call would push the binding past `TASK_RECORDS_MAX_RUNS_PER_BINDING`.
   *  Refused as a whole so the stored state does not depend on the order the
   *  caller listed the rows in. */
  | { kind: 'limit' }
  | { kind: 'unchanged' }
  | { kind: 'changed'; runs: TaskRecordRun[]; gaps?: TaskRecordGap[] }

export type TaskRecordRunMergeInput = {
  existing: readonly TaskRecordRun[]
  /** `binding.gaps`, i.e. absences that belong to the binding, not to one run. */
  existingGaps?: readonly TaskRecordGap[]
  runs: readonly TaskRecordRun[]
  gaps?: readonly TaskRecordGap[]
}

export function mergeRunRows(input: TaskRecordRunMergeInput): TaskRecordRunMerge {
  const rows = [...input.existing]
  let changed = false
  for (const observation of input.runs) {
    const claim = taskRecordRunClaimKey(observation.providerSession)
    const index = rows.findIndex((row) => taskRecordRunClaimKey(row.providerSession) === claim)
    if (index === -1) {
      if (rows.length >= TASK_RECORDS_MAX_RUNS_PER_BINDING) {
        return { kind: 'limit' }
      }
      // The stored `key` is the claim itself, so the page has a stable row key
      // and a caller cannot invent one (a timestamp key would duplicate rows).
      rows.push({ ...observation, key: claim })
      changed = true
      continue
    }
    const merged = mergeRunObservation(rows[index], observation)
    if (merged === null) {
      continue
    }
    rows[index] = merged
    changed = true
  }
  const gaps = mergeGapRows(input.existingGaps ?? [], input.gaps ?? [])
  if (!changed && gaps === null) {
    return { kind: 'unchanged' }
  }
  return { kind: 'changed', runs: rows, ...(gaps === null ? {} : { gaps }) }
}

function mergeSessionObservation(
  existing: TaskRecordSession,
  incoming: TaskRecordSession
): TaskRecordSession | null {
  const transcriptCheck = newestTranscriptCheck(existing.transcriptCheck, incoming.transcriptCheck)
  const next: TaskRecordSession = {
    ...existing,
    ...(isNotOlder(incoming, existing) ? observedSessionFacts(incoming) : {}),
    ...(transcriptCheck === undefined ? {} : { transcriptCheck }),
    ...(existing.source === undefined && incoming.source !== undefined
      ? { source: incoming.source }
      : {}),
    ...(existing.recordedAt === undefined && incoming.recordedAt !== undefined
      ? { recordedAt: incoming.recordedAt }
      : {}),
    firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt)
  }
  return sessionShape(next) === sessionShape(existing) ? null : next
}

function mergeRunObservation(
  existing: TaskRecordRun,
  incoming: TaskRecordRun
): TaskRecordRun | null {
  const gaps = mergeGapRows(existing.gaps ?? [], incoming.gaps ?? [])
  const transcriptCheck = newestTranscriptCheck(existing.transcriptCheck, incoming.transcriptCheck)
  const next: TaskRecordRun = {
    ...existing,
    ...(isNotOlder(incoming, existing) ? observedRunFacts(incoming) : {}),
    ...(transcriptCheck === undefined ? {} : { transcriptCheck }),
    ...(gaps === null ? {} : { gaps }),
    firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt)
  }
  return runShape(next) === runShape(existing) ? null : next
}

/** The union of the binding-level absences, or null when nothing moved. */
function mergeGapRows(
  existing: readonly TaskRecordGap[],
  incoming: readonly TaskRecordGap[]
): TaskRecordGap[] | null {
  if (incoming.length === 0) {
    return null
  }
  const rows = [...existing]
  let changed = false
  for (const observation of incoming) {
    const identity = gapIdentity(observation)
    const index = rows.findIndex((row) => gapIdentity(row) === identity)
    if (index === -1) {
      rows.push(observation)
      changed = true
      continue
    }
    const merged = mergeGapObservation(rows[index], observation)
    if (merged === null) {
      continue
    }
    rows[index] = merged
    changed = true
  }
  return changed ? rows : null
}

function mergeGapObservation(
  existing: TaskRecordGap,
  incoming: TaskRecordGap
): TaskRecordGap | null {
  const next: TaskRecordGap = {
    ...existing,
    ...(incoming.candidateCount === undefined ? {} : { candidateCount: incoming.candidateCount }),
    ...(incoming.detail === undefined ? {} : { detail: incoming.detail })
  }
  return gapShape(next) === gapShape(existing) ? null : next
}

/** See the header rule: facts come only from an observation that is not older than
 *  the stored one. `recordedAt` is the clock; a row without one (a v1 session) is
 *  placed by the end of its observation window, which is the latest moment it can
 *  have been seen. */
function isNotOlder(
  incoming: { recordedAt?: number; lastSeenAt: number },
  existing: { recordedAt?: number; lastSeenAt: number }
): boolean {
  return (incoming.recordedAt ?? incoming.lastSeenAt) >= (existing.recordedAt ?? existing.lastSeenAt)
}

/** See the header rule: freshest `checkedAt` wins as one whole check; an equal
 *  timestamp keeps the stored one, so an identical replay is `changed: false`. */
function newestTranscriptCheck(
  existing: TaskRecordTranscriptCheck | undefined,
  incoming: TaskRecordTranscriptCheck | undefined
): TaskRecordTranscriptCheck | undefined {
  if (incoming === undefined) {
    return existing
  }
  if (existing === undefined || incoming.checkedAt > existing.checkedAt) {
    return incoming
  }
  return existing
}

function gapIdentity(gap: TaskRecordGap): string {
  return `${gap.kind}|${gap.detail ?? ''}`
}

function observedSessionFacts(session: TaskRecordSession): Partial<TaskRecordSession> {
  return {
    ...(session.transcriptPath === undefined ? {} : { transcriptPath: session.transcriptPath }),
    ...(session.agentType === undefined ? {} : { agentType: session.agentType }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.resumeCommand === undefined ? {} : { resumeCommand: session.resumeCommand }),
    ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
    ...(session.messageCount === undefined ? {} : { messageCount: session.messageCount })
  }
}

/** Deliberately excludes `key`, `providerSession` (identity), `source` and
 *  `recordedAt` (provenance): a match on the claim already agrees on identity,
 *  and provenance is first-writer-wins. */
function observedRunFacts(run: TaskRecordRun): Partial<TaskRecordRun> {
  return {
    ...(run.title === undefined ? {} : { title: run.title }),
    ...(run.resumeCommand === undefined ? {} : { resumeCommand: run.resumeCommand }),
    ...(run.agentType === undefined ? {} : { agentType: run.agentType }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.messageCount === undefined ? {} : { messageCount: run.messageCount }),
    ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
    ...(run.transcriptPath === undefined ? {} : { transcriptPath: run.transcriptPath })
  }
}

/**
 * Change detection, spelled as fixed-order arrays rather than a deep-equal so
 * the compared fields are enumerated (a field added to the type but not here
 * would silently stop counting as a change). Absent becomes `null`, which cannot
 * collide with any stored value because a stored number is finite and a stored
 * string is non-empty.
 */
function sessionShape(session: TaskRecordSession): string {
  return JSON.stringify([
    session.provider ?? null,
    session.key,
    session.id,
    session.transcriptPath ?? null,
    session.agentType ?? null,
    session.title ?? null,
    session.resumeCommand ?? null,
    session.startedAt ?? null,
    session.endedAt ?? null,
    session.messageCount ?? null,
    session.source ?? null,
    session.recordedAt ?? null,
    session.transcriptCheck === undefined
      ? null
      : taskRecordTranscriptCheckShape(session.transcriptCheck),
    session.firstSeenAt,
    session.lastSeenAt
  ])
}

function runShape(run: TaskRecordRun): string {
  return JSON.stringify([
    run.key,
    run.providerSession.provider ?? null,
    run.providerSession.key,
    run.providerSession.id,
    run.title ?? null,
    run.agentType ?? null,
    run.resumeCommand ?? null,
    run.startedAt ?? null,
    run.endedAt ?? null,
    run.messageCount ?? null,
    run.outcome ?? null,
    run.transcriptPath ?? null,
    run.transcriptCheck === undefined
      ? null
      : taskRecordTranscriptCheckShape(run.transcriptCheck),
    run.source,
    run.recordedAt,
    (run.gaps ?? []).map(gapShape),
    run.firstSeenAt,
    run.lastSeenAt
  ])
}

function gapShape(gap: TaskRecordGap): string {
  return JSON.stringify([gap.kind, gap.candidateCount ?? null, gap.observedAt, gap.detail ?? null])
}
