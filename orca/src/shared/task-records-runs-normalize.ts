import { isAgentJournalTurnOutcome } from './agent-turn-outcome'
import {
  TASK_RECORDS_MAX_RUNS_PER_BINDING,
  isTaskRecordGapKind,
  isTaskRecordSnapshotSource,
  isTaskRecordUsageProvider,
  taskRecordRunClaimKey,
  type TaskRecordGap,
  type TaskRecordProviderSession,
  type TaskRecordRun,
  type TaskRecordSession,
  type TaskRecordSnapshotSource,
  type TaskRecordsDiscardedFacts,
  type TaskRecordUsageProvider
} from './task-records-types'
import {
  KNOWN_GAP_FIELDS,
  KNOWN_PROVIDER_SESSION_FIELDS,
  KNOWN_RUN_FIELDS,
  KNOWN_SESSION_FIELDS
} from './task-records-preserved-fields'
import { normalizeTranscriptCheck } from './task-records-runs-transcript'

/**
 * Load-boundary normalization of the two **observation rows** this domain
 * stores: `sessions` (v1) and `runs`/`gaps` (v2, issue #53).
 *
 * Split from `task-records-normalize.ts` because that module is at its
 * `max-lines` budget, and because these rows follow a stricter rule than the
 * record and binding around them: a record or binding keeps fields this build
 * does not know (a downgrade must not delete a newer build's data), while a row
 * is rebuilt from the fields this build can name. The reason is that a row is a
 * *fact about a run*: an unknown field inside it cannot have come from a newer
 * build without that build having raised `schemaVersion` (which rejects the
 * whole domain), so an extra key there is junk, and keeping it verbatim would
 * make it indistinguishable from a value some writer measured. Everything
 * dropped here is counted, so a hand-edited or downgraded payload cannot lose
 * rows silently.
 */


export function normalizeSessionRows(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): TaskRecordSession[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: TaskRecordSession[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      discarded.sessions += 1
      continue
    }
    countUnknownFields(entry, KNOWN_SESSION_FIELDS, discarded)
    const key = nonEmptyString(entry.key)
    const id = nonEmptyString(entry.id)
    const firstSeenAt = finiteNumber(entry.firstSeenAt)
    const lastSeenAt = finiteNumber(entry.lastSeenAt)
    if (key === null || id === null || firstSeenAt === null || lastSeenAt === null) {
      discarded.sessions += 1
      continue
    }
    const agentType = stringField(entry.agentType, discarded)
    const title = stringField(entry.title, discarded)
    const resumeCommand = stringField(entry.resumeCommand, discarded)
    const startedAt = finiteField(entry.startedAt, discarded)
    const endedAt = finiteField(entry.endedAt, discarded)
    const messageCount = countField(entry.messageCount, discarded)
    const transcriptPath = stringField(entry.transcriptPath, discarded)
    const source = sourceField(entry.source, discarded)
    const recordedAt = finiteField(entry.recordedAt, discarded)
    const transcriptCheck = normalizeTranscriptCheck(entry.transcriptCheck, discarded)
    rows.push({
      ...providerField(entry.provider, discarded),
      key,
      id,
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
      ...(agentType === undefined ? {} : { agentType }),
      ...(title === undefined ? {} : { title }),
      ...(resumeCommand === undefined ? {} : { resumeCommand }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(messageCount === undefined ? {} : { messageCount }),
      ...(source === undefined ? {} : { source }),
      ...(recordedAt === undefined ? {} : { recordedAt }),
      ...(transcriptCheck === undefined ? {} : { transcriptCheck }),
      firstSeenAt,
      lastSeenAt
    })
  }
  return rows
}

export function normalizeRunRows(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): TaskRecordRun[] {
  if (!Array.isArray(value)) {
    // A present-but-unreadable `runs` is one unusable field, counted once rather
    // than as an unknowable number of rows; absent is simply "no runs recorded".
    discarded.fields += value === undefined ? 0 : 1
    return []
  }
  const rows: TaskRecordRun[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      discarded.runs += 1
      continue
    }
    countUnknownFields(entry, KNOWN_RUN_FIELDS, discarded)
    const storedKey = nonEmptyString(entry.key)
    const providerSession = normalizeProviderSession(entry.providerSession, discarded)
    const firstSeenAt = finiteNumber(entry.firstSeenAt)
    const lastSeenAt = finiteNumber(entry.lastSeenAt)
    const source = sourceField(entry.source, discarded)
    const recordedAt = finiteField(entry.recordedAt, discarded)
    // Provenance is required on a run: a row without it cannot be told apart
    // from a guess, and the page shows reliability by source. Dropping the row
    // is the honest reading of "an observation that did not say how it knew".
    if (
      storedKey === null ||
      !providerSession ||
      source === undefined ||
      recordedAt === undefined ||
      firstSeenAt === null ||
      lastSeenAt === null
    ) {
      discarded.runs += 1
      continue
    }
    // Identity is the claim, so the stored `key` is recomputed rather than
    // trusted: the reader dedupes on `key`, and a hand-edited key would mint a
    // second row for a session the merge already treats as one. A mismatch is a
    // discarded field, not a second identity.
    const key = taskRecordRunClaimKey(providerSession)
    if (storedKey !== key) {
      discarded.fields += 1
    }
    const agentType = stringField(entry.agentType, discarded)
    const title = stringField(entry.title, discarded)
    const resumeCommand = stringField(entry.resumeCommand, discarded)
    const startedAt = finiteField(entry.startedAt, discarded)
    const endedAt = finiteField(entry.endedAt, discarded)
    const messageCount = countField(entry.messageCount, discarded)
    const outcome = outcomeField(entry.outcome, discarded)
    const transcriptPath = stringField(entry.transcriptPath, discarded)
    const transcriptCheck = normalizeTranscriptCheck(entry.transcriptCheck, discarded)
    const gaps = normalizeGapRows(entry.gaps, discarded)
    rows.push({
      key,
      providerSession,
      ...(title === undefined ? {} : { title }),
      ...(agentType === undefined ? {} : { agentType }),
      ...(resumeCommand === undefined ? {} : { resumeCommand }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(messageCount === undefined ? {} : { messageCount }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
      ...(transcriptCheck === undefined ? {} : { transcriptCheck }),
      source,
      recordedAt,
      ...(gaps.length === 0 ? {} : { gaps }),
      firstSeenAt,
      lastSeenAt
    })
  }
  // Over the cap on the load path: trim and count. Keeping more rows than a
  // write may ever store would make the invariant depend on who wrote the file.
  // The trim keeps the **first 16 in file order**, not the newest 16: the record
  // states no order, so re-sorting would invent one this build did not store (a
  // writer refuses growth past the cap instead, and a later snapshot updates the
  // rows it already has).
  if (rows.length > TASK_RECORDS_MAX_RUNS_PER_BINDING) {
    discarded.runs += rows.length - TASK_RECORDS_MAX_RUNS_PER_BINDING
    rows.length = TASK_RECORDS_MAX_RUNS_PER_BINDING
  }
  return rows
}

export function normalizeGapRows(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): TaskRecordGap[] {
  if (!Array.isArray(value)) {
    // Mirrors the `runs` arm: a present-but-unreadable `gaps` is one unusable
    // field and is counted, so a hand-edited `gaps: "…"` cannot vanish silently.
    discarded.fields += value === undefined ? 0 : 1
    return []
  }
  const rows: TaskRecordGap[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      discarded.gaps += 1
      continue
    }
    countUnknownFields(entry, KNOWN_GAP_FIELDS, discarded)
    const observedAt = finiteNumber(entry.observedAt)
    const candidateCount = countField(entry.candidateCount, discarded)
    const detail = stringField(entry.detail, discarded)
    if (!isTaskRecordGapKind(entry.kind) || observedAt === null) {
      discarded.gaps += 1
      continue
    }
    rows.push({
      kind: entry.kind,
      ...(candidateCount === undefined ? {} : { candidateCount }),
      observedAt,
      ...(detail === undefined ? {} : { detail })
    })
  }
  return rows
}

function normalizeProviderSession(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): TaskRecordProviderSession | null {
  if (!isRecord(value)) {
    return null
  }
  countUnknownFields(value, KNOWN_PROVIDER_SESSION_FIELDS, discarded)
  const key = nonEmptyString(value.key)
  const id = nonEmptyString(value.id)
  if (key === null || id === null) {
    return null
  }
  return { ...providerField(value.provider, discarded), key, id }
}

/** A provider value this build does not know becomes *absent* (unknown), which
 *  is what the rest of the build means by "not one of the four". Keeping the raw
 *  string would print a provider no usage rule can attribute. */
function providerField(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): { provider?: TaskRecordUsageProvider } {
  if (isTaskRecordUsageProvider(value)) {
    return { provider: value }
  }
  if (value !== undefined) {
    discarded.providers += 1
  }
  return {}
}

function sourceField(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): TaskRecordSnapshotSource | undefined {
  if (value === undefined) {
    return undefined
  }
  if (isTaskRecordSnapshotSource(value)) {
    return value
  }
  discarded.fields += 1
  return undefined
}

function outcomeField(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): TaskRecordRun['outcome'] {
  if (value === undefined) {
    return undefined
  }
  if (isAgentJournalTurnOutcome(value)) {
    return value
  }
  discarded.fields += 1
  return undefined
}

function stringField(value: unknown, discarded: TaskRecordsDiscardedFacts): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = nonEmptyString(value)
  if (parsed === null) {
    discarded.fields += 1
  }
  return parsed ?? undefined
}

function finiteField(value: unknown, discarded: TaskRecordsDiscardedFacts): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = finiteNumber(value)
  if (parsed === null) {
    discarded.fields += 1
  }
  return parsed ?? undefined
}

function countField(value: unknown, discarded: TaskRecordsDiscardedFacts): number | undefined {
  const parsed = finiteField(value, discarded)
  if (parsed === undefined) {
    return undefined
  }
  if (!Number.isInteger(parsed) || parsed < 0) {
    discarded.fields += 1
    return undefined
  }
  return parsed
}

function countUnknownFields(
  entry: Record<string, unknown>,
  known: readonly string[],
  discarded: TaskRecordsDiscardedFacts
): void {
  for (const name of Object.keys(entry)) {
    if (!known.includes(name)) {
      discarded.fields += 1
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
