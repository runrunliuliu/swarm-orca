/**
 * The field-name registry of the `taskRecords` domain, for both halves of the
 * load boundary.
 *
 * Records and bindings: a field this build does not know is carried through a
 * load/save round-trip. Why not just rebuild the known fields: a downgrade is a
 * supported state (design doc §8.6), and a rebuild would delete whatever the
 * newer build wrote the moment the older one saved. Keeping the extras verbatim
 * is what makes the round-trip non-destructive.
 *
 * Rows (`sessions`, `runs`, `gaps`, the transcript check): the opposite. A row is
 * rebuilt from the names below and an unknown name is dropped **and counted**
 * (`task-records-runs-normalize.ts`), because a fact row cannot have come from a
 * newer build without that build raising `schemaVersion`, which rejects the whole
 * domain — so an extra key there is junk, and keeping it would make it
 * indistinguishable from a value some writer measured.
 */
export const KNOWN_RECORD_FIELDS = [
  'taskId',
  'hostId',
  'origin',
  'bindings',
  'primaryWorktreeId',
  'intent',
  'createdAt',
  'updatedAt',
  'schemaVersion'
] as const

export const KNOWN_BINDING_FIELDS = [
  'worktreeId',
  'repoId',
  'hostId',
  'path',
  'isArchived',
  'boundAt',
  'boundBy',
  'lastVerifiedAt',
  'resolvedVia',
  'sessions',
  'runs',
  'gaps',
  'usageSettlement'
] as const

export function withPreservedFields<T extends object>(
  value: T,
  raw: Record<string, unknown>,
  known: readonly string[]
): T {
  const extras: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(raw)) {
    if (!known.includes(key)) {
      extras[key] = field
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spread only adds keys absent from the typed shape, so every declared field keeps its validated type.
  return { ...value, ...extras } as T
}

export const KNOWN_DOMAIN_FIELDS = ['recordsVersion', 'byId', 'externalIndex'] as const

export const KNOWN_SESSION_FIELDS = [
  'provider',
  'key',
  'id',
  'transcriptPath',
  'agentType',
  'title',
  'resumeCommand',
  'startedAt',
  'endedAt',
  'messageCount',
  'source',
  'recordedAt',
  'transcriptCheck',
  'firstSeenAt',
  'lastSeenAt'
] as const

export const KNOWN_RUN_FIELDS = [
  'key',
  'providerSession',
  'title',
  'agentType',
  'resumeCommand',
  'startedAt',
  'endedAt',
  'messageCount',
  'outcome',
  'transcriptPath',
  'source',
  'recordedAt',
  'transcriptCheck',
  'gaps',
  'firstSeenAt',
  'lastSeenAt'
] as const

export const KNOWN_GAP_FIELDS = ['kind', 'candidateCount', 'observedAt', 'detail'] as const
export const KNOWN_PROVIDER_SESSION_FIELDS = ['provider', 'key', 'id'] as const
export const KNOWN_TRANSCRIPT_CHECK_FIELDS = [
  'checkedAt',
  'presence',
  'dev',
  'ino',
  'mtimeMs',
  'size'
] as const
