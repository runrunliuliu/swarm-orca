/**
 * Fields this build does not know are carried through a load/save round-trip.
 *
 * Why not just rebuild the known fields: a downgrade is a supported state
 * (design doc §8.6), and a rebuild would delete whatever the newer build wrote
 * the moment the older one saved. Keeping the extras verbatim is what makes the
 * round-trip non-destructive.
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
