import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type {
  TaskRecord,
  TaskRecordGap,
  TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import { mergeRunRows, mergeSessionRows } from '../../../../shared/task-records-runs-merge'

/**
 * Which profiles a task page's history is read from, and how two answers for the
 * same task become one record (issue #31 cross-profile gap).
 *
 * The problem this module exists for: a record is written where the workspace is
 * — on the runtime, into the runtime's own profile. `taskRecords:get` reads the
 * *client's* profile, so a task whose workspace ran on a remote environment had
 * its history in a database the Orca tab never opened, and the panel printed the
 * never-started state for work that really ran.
 *
 * Three rules, and each is why the shape looks like this:
 *
 * 1. **Sources are selected by evidence, not by focus.** The environments asked
 *    are the ones this task's own workspaces (and its record's bindings) name as
 *    their host. A runtime that is merely focused is never asked: "this client is
 *    looking at environment X" is not a statement about where this task ran.
 *
 * 2. **The local profile is always read.** It is the path that already existed, it
 *    is the only source that always exists, and it is what "keep what you have"
 *    degrades to when an environment cannot answer. It is not authoritative for a
 *    remote workspace — see rule 3 — but it is never skipped.
 *
 * 3. **Authority is per binding, by the host the binding names, and facts are
 *    unioned.** A `TaskWorkspaceBinding` carries `hostId`, so the profile that
 *    owns that checkout is the one whose identity fields (`path`, `isArchived`,
 *    `lastVerifiedAt`, …) are kept; the other source's *facts* (sessions, runs,
 *    gaps) are folded in with the existing observation merge
 *    (`task-records-runs-merge.ts`), so a row only one side saw is never
 *    discarded and a re-observation of one row keeps the newer facts. A real
 *    disagreement (two profiles placing one worktree on different hosts, or
 *    disagreeing about its path) is reported in `conflicts` instead of being
 *    silently resolved, because the reader is entitled to know the two databases
 *    do not agree.
 */

/** Why a source could not answer. Every arm is a *different* decision for the
 *  reader: an old runtime is a version gap, a forbidden one is a scope gap, a
 *  repo the host never registered is a wrong-environment gap, and a transport
 *  failure is a retry. None of them means "this task has no history". */
export const TASK_RECORD_SOURCE_FAILURES = [
  'unsupported',
  'forbidden',
  'repo-unknown',
  'unreachable'
] as const
export type TaskRecordSourceFailure = (typeof TASK_RECORD_SOURCE_FAILURES)[number]

/** One source's answer. `answered` with `record: null` is a real answer ("this
 *  profile knows the repo and has no record for that task"); `unavailable` is a
 *  non-answer and must never be read as the former. */
export type TaskRecordSourceAnswer =
  | { target: RuntimeClientTarget; kind: 'answered'; record: TaskRecord | null }
  | { target: RuntimeClientTarget; kind: 'unavailable'; failure: TaskRecordSourceFailure }

/** The fields two sources can disagree about and the panel can name. */
export type TaskRecordSourceConflictField =
  | 'hostId'
  | 'path'
  | 'isArchived'
  | 'runs-over-cap'
  | 'sessions-over-cap'

export type TaskRecordSourceConflict = {
  worktreeId: string
  /** The source whose values were kept. */
  kept: RuntimeClientTarget
  /** The other source(s) that stated this binding. */
  others: RuntimeClientTarget[]
  fields: TaskRecordSourceConflictField[]
}

export type TaskRecordSources = {
  /** The merged record, or `null` when no source had one. `null` here means "no
   *  source that answered recorded this task", never "nobody could be asked" —
   *  that is `unavailable`. */
  record: TaskRecord | null
  /** Sources that answered, in the order they were asked (local first). */
  answered: RuntimeClientTarget[]
  /** Sources that could not answer, with the reason. Empty is the honest "every
   *  source this task has was reachable". */
  unavailable: { target: RuntimeClientTarget; failure: TaskRecordSourceFailure }[]
  conflicts: TaskRecordSourceConflict[]
}

/** The host a workspace row names, as the store spells it. `runtimeOwnerEnvironmentId`
 *  is the renderer's own projection of which paired runtime transports this
 *  workspace's operations, so it is more specific than `hostId` and wins; an
 *  absent pair is `undefined` — unknown, which selects no source at all rather
 *  than defaulting this task to whichever environment happens to be focused. */
export function worktreeRecordHostId(worktree: {
  hostId?: ExecutionHostId | null
  runtimeOwnerEnvironmentId?: string | null
}): ExecutionHostId | undefined {
  const owner = worktree.runtimeOwnerEnvironmentId?.trim()
  if (owner) {
    return toRuntimeExecutionHostId(owner)
  }
  return worktree.hostId ?? undefined
}

/** Which environments this task's history can live in, from the evidence the
 *  store already holds. The local profile is not listed: it is always read (see
 *  the module note), so listing it would be a second way to say the same thing. */
export function selectTaskRecordEnvironments(args: {
  /** Execution hosts of this task's workspace rows, store order. An absent host
   *  is `undefined`, which is *not* local — it is unknown, and unknown selects
   *  nothing. */
  worktreeHostIds: readonly (ExecutionHostId | undefined)[]
  /** Host ids the locally-read record's bindings name. A binding can outlive its
   *  workspace row, and then the record is the only evidence that this task's
   *  history may be on that environment. */
  bindingHostIds?: readonly (ExecutionHostId | undefined)[]
}): string[] {
  const environmentIds: string[] = []
  for (const hostId of [...args.worktreeHostIds, ...(args.bindingHostIds ?? [])]) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'runtime') {
      continue
    }
    if (!environmentIds.includes(parsed.environmentId)) {
      environmentIds.push(parsed.environmentId)
    }
  }
  return environmentIds
}

/** Append a disagreement once. Two rules can observe the same field (a differing
 *  `hostId` and the "neither profile owns it" tie-break), and the sentence must
 *  name it once. */
function noteField(
  fields: TaskRecordSourceConflictField[],
  field: TaskRecordSourceConflictField
): void {
  if (!fields.includes(field)) {
    fields.push(field)
  }
}

function targetMatchesBinding(
  target: RuntimeClientTarget,
  binding: TaskWorkspaceBinding
): boolean {
  const parsed = parseExecutionHostId(binding.hostId)
  if (target.kind === 'local') {
    return parsed?.kind === 'local'
  }
  return parsed?.kind === 'runtime' && parsed.environmentId === target.environmentId
}

/** One source's view of the record, paired with the target it came from. */
type SourceRecord = { target: RuntimeClientTarget; record: TaskRecord }

/** `kind|detail` is the gap identity the domain's own merge uses; two sources
 *  that observed one absence must print it once. */
function gapKey(gap: TaskRecordGap): string {
  return `${gap.kind}|${gap.detail ?? ''}`
}

function unionGaps(
  existing: readonly TaskRecordGap[],
  incoming: readonly TaskRecordGap[]
): TaskRecordGap[] | null {
  const known = new Set(existing.map(gapKey))
  const added = incoming.filter((gap) => !known.has(gapKey(gap)) && known.add(gapKey(gap)))
  return added.length === 0 ? null : [...existing, ...added]
}

/**
 * Fold every source's record into one, per the three rules in the module note.
 *
 * `sources` must be ordered with the local profile first: that order is the
 * tie-break for anything the bindings cannot attribute (record shell, and a
 * binding no source's host matches), so a caller that reorders it changes which
 * profile wins a tie. It cannot change which bindings or rows survive.
 */
export function mergeTaskRecordSources(args: {
  local: TaskRecord | null
  answers: readonly TaskRecordSourceAnswer[]
}): TaskRecordSources {
  const localTarget: RuntimeClientTarget = { kind: 'local' }
  // The local profile is always read (module note, rule 2), so it is always in
  // `answered`: it either has a record or answered `null`, and both are answers.
  const answered: RuntimeClientTarget[] = [localTarget]
  const unavailable: TaskRecordSources['unavailable'] = []
  const records: SourceRecord[] = []
  if (args.local) {
    records.push({ target: localTarget, record: args.local })
  }
  for (const answer of args.answers) {
    if (answer.kind === 'unavailable') {
      unavailable.push({ target: answer.target, failure: answer.failure })
      continue
    }
    answered.push(answer.target)
    if (answer.record) {
      records.push({ target: answer.target, record: answer.record })
    }
  }
  const base = records[0]
  if (!base) {
    return { record: null, answered, unavailable, conflicts: [] }
  }
  // One source is the local-only task (or a task whose only record is on one
  // environment): the answer is that record, unchanged and the same object. This
  // is what keeps the local behaviour bit-for-bit what it was before records had
  // more than one possible source — no rebuild, no reordered binding, nothing for
  // a memo downstream to see.
  if (records.length === 1) {
    return { record: base.record, answered, unavailable, conflicts: [] }
  }

  // worktreeId -> the sources that stated it, in the caller's order.
  const statements = new Map<string, { source: SourceRecord; binding: TaskWorkspaceBinding }[]>()
  for (const source of records) {
    for (const binding of source.record.bindings) {
      const list = statements.get(binding.worktreeId)
      const entry = { source, binding }
      if (list) {
        list.push(entry)
      } else {
        statements.set(binding.worktreeId, [entry])
      }
    }
  }

  const conflicts: TaskRecordSourceConflict[] = []
  const bindings: TaskWorkspaceBinding[] = []
  for (const [worktreeId, entries] of statements) {
    const owner =
      entries.find((entry) => targetMatchesBinding(entry.source.target, entry.binding)) ??
      entries[0]
    const others = entries.filter((entry) => entry !== owner)
    const fields: TaskRecordSourceConflictField[] = []
    if (others.length > 0) {
      for (const field of ['hostId', 'path', 'isArchived'] as const) {
        if (others.some((entry) => entry.binding[field] !== owner.binding[field])) {
          noteField(fields, field)
        }
      }
      if (
        !targetMatchesBinding(owner.source.target, owner.binding) &&
        others.every((entry) => !targetMatchesBinding(entry.source.target, entry.binding))
      ) {
        // Neither profile says it owns this checkout, so the tie-break chose. The
        // reader must not be told the two databases agreed.
        noteField(fields, 'hostId')
      }
    }
    let merged = owner.binding
    for (const entry of others) {
      merged = foldBindingFacts(merged, entry.binding, fields)
    }
    if (fields.length > 0) {
      conflicts.push({
        worktreeId,
        kept: owner.source.target,
        others: others.map((entry) => entry.source.target),
        fields
      })
    }
    bindings.push(merged)
  }

  const timestamps = records.map((source) => source.record)
  const record: TaskRecord = {
    ...base.record,
    bindings,
    createdAt: Math.min(...timestamps.map((candidate) => candidate.createdAt)),
    updatedAt: Math.max(...timestamps.map((candidate) => candidate.updatedAt)),
    schemaVersion: Math.max(...timestamps.map((candidate) => candidate.schemaVersion))
  }
  return { record, answered, unavailable, conflicts }
}

/**
 * Keep the owner's identity fields and union the facts (rule 3). Unioned rather
 * than replaced on purpose: a session or run one profile recorded and the other
 * did not is evidence, and dropping it would make the merge a source pick in
 * disguise. The observation merge is the same one the write path uses, so a row
 * both sides observed keeps its newest measured facts.
 *
 * `fields` is appended to when a fact could not be folded — the per-binding run
 * cap is a refusal, not a truncation, so the owner's rows are kept whole and the
 * reader is told the other source's rows did not fit.
 */
function foldBindingFacts(
  owner: TaskWorkspaceBinding,
  other: TaskWorkspaceBinding,
  fields: TaskRecordSourceConflictField[]
): TaskWorkspaceBinding {
  const sessions = mergeSessionRows(owner.sessions, other.sessions)
  const runFold = mergeRunRows({
    existing: owner.runs ?? [],
    existingGaps: owner.gaps ?? [],
    runs: other.runs ?? [],
    gaps: other.gaps ?? []
  })
  // The per-binding caps refuse rather than truncate (the domain's own rule), so
  // the owner's rows are kept whole and the reader is told the other source's
  // rows did not fit. Nothing is dropped silently in either direction.
  if (runFold.kind === 'limit') {
    noteField(fields, 'runs-over-cap')
  }
  if (sessions.changed && sessions.dropped > 0) {
    noteField(fields, 'sessions-over-cap')
  }
  const gaps =
    runFold.kind === 'changed'
      ? runFold.gaps
      : (unionGaps(owner.gaps ?? [], other.gaps ?? []) ?? undefined)
  const runs = runFold.kind === 'changed' ? runFold.runs : owner.runs
  const usageSettlement = owner.usageSettlement ?? other.usageSettlement
  return {
    ...owner,
    sessions: sessions.changed ? sessions.sessions : owner.sessions,
    // Absent stays absent: `runs: []` would claim the writer looked and stored
    // none, which is a different fact from "this profile never recorded runs".
    ...(runs === undefined ? {} : { runs }),
    ...(gaps === undefined ? {} : { gaps }),
    ...(usageSettlement === undefined ? {} : { usageSettlement })
  }
}

/** True when every source this task has answered, so the panel may present the
 *  merged record as the whole picture instead of "what we could reach". */
export function taskRecordSourcesComplete(sources: TaskRecordSources): boolean {
  return sources.unavailable.length === 0
}
