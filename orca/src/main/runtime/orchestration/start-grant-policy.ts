import { posix } from 'node:path'
import { z } from 'zod'
import { hashCanonical } from '../rpc/orchestration-mutation-receipt'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { strictTerminalAuthoritySchema } from './strict-coordinator-policy'

// One format for the grant record, validated on write *and* on read: a row that no longer parses is
// an invalid record, never "no grant". Treating it as absent would silently disable the cap, because
// "this Run has no grant" is a state the spawn path is allowed to see.
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
// One spelling per directory: `/` is canonical but meaningless as a writable declaration (the Trae
// launch path refuses it too), and `posix.normalize` keeps a trailing slash, so it is refused here
// explicitly rather than being left to look like a second, different root in the delivery report.
const canonicalAbsolutePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('/') &&
      posix.normalize(value) === value &&
      value !== '/' &&
      !value.endsWith('/'),
    'must be an absolute canonical path below the filesystem root, without a trailing slash'
  )

export const startGrantRefSchema = z.object({
  path: z.string().min(1),
  sha256
})

/** `null` means every worktree of that repo; a list means only those worktree ids. */
const startGrantRepoScopeSchema = z.object({
  repoId: z.string().min(1),
  worktreeIds: z.array(z.string().min(1)).min(1).max(64).nullable()
})

const startGrantObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('start_grant'),
    grantId: z.string().uuid(),
    objectiveText: z.string().min(1).max(16_384),
    objectiveHash: sha256,
    taskSource: startGrantRefSchema,
    authorizationRefs: z.array(startGrantRefSchema).max(32),
    maxWorkers: z.number().int().min(1),
    repos: z.array(startGrantRepoScopeSchema).min(1).max(32),
    writableRoots: z.array(canonicalAbsolutePath).max(32),
    spend: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('capped'), limitUsd: z.number().positive() })
    ]),
    deadline: z.string().datetime({ offset: true }),
    minter: strictTerminalAuthoritySchema,
    mintedAt: z.string().datetime({ offset: true }),
    executionAuthorized: z.literal(false)
  })

// The refinements live here, after the object, so the submission shape can omit `minter` without
// zod refusing `.omit()` on a refined schema.
export const startGrantSchema = startGrantObjectSchema.superRefine((grant, ctx) => {
  if (Date.parse(grant.deadline) <= Date.parse(grant.mintedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline'],
      message: 'must be after mintedAt'
    })
  }
  if (grant.objectiveHash !== objectiveHashOf(grant.objectiveText)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['objectiveHash'],
      message: 'must be the hash of objectiveText'
    })
  }
  assertUnique(ctx, grant.repos.map((scope) => scope.repoId), ['repos'])
  for (const [index, scope] of grant.repos.entries()) {
    assertUnique(ctx, scope.worktreeIds ?? [], ['repos', index, 'worktreeIds'])
  }
  assertUnique(ctx, grant.writableRoots, ['writableRoots'])
})

export const startGrantRevocationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('start_grant_revocation'),
  grantId: z.string().uuid(),
  revokedAt: z.string().datetime({ offset: true }),
  authority: strictTerminalAuthoritySchema,
  reason: z.string().min(1).max(2048),
  executionAuthorized: z.literal(false)
})

export const startGrantBindingSchema = z.object({
  grantId: z.string().uuid(),
  runId: z.string().min(1),
  boundAt: z.string().datetime({ offset: true }),
  boundAuthority: strictTerminalAuthoritySchema
})

/**
 * What a client may submit. `minter` is not in it: the caller cannot read its own `launchTokenHash`
 * (every receipt deliberately omits it), so it could never reproduce the authority the server stores.
 * The server writes `minter` from the verified live caller, and a record that tries to name one is
 * refused rather than silently ignored — an approval must not be able to claim another terminal.
 */
export const startGrantSubmittedSchema = startGrantObjectSchema.omit({ minter: true })

export type StartGrant = z.infer<typeof startGrantSchema>
export type StartGrantSubmission = z.infer<typeof startGrantSubmittedSchema>
export type StartGrantRevocation = z.infer<typeof startGrantRevocationSchema>
export type StartGrantBinding = z.infer<typeof startGrantBindingSchema>
export type StartGrantRepoScope = z.infer<typeof startGrantRepoScopeSchema>

function assertUnique(ctx: z.RefinementCtx, values: readonly string[], path: (string | number)[]): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'must not repeat a value' })
  }
}

/**
 * The one definition of "the objective this grant approves".
 *
 * `createRun` compares `objectiveHashOf(params.objective)` against the record, so the canonical JSON
 * spelling has to be shared rather than re-derived: for a string, `hashCanonical` is
 * `sha256(JSON.stringify(value))`, which is what makes the equality check exact instead of fuzzy.
 */
export function objectiveHashOf(objective: string): string {
  return hashCanonical(objective)
}

export function invalidGrantRecord(grantId: string, reason: string): never {
  throw new OrchestrationError(
    'start_grant_invalid_record',
    `Start grant ${grantId} has an unreadable record (${reason}); it cannot be treated as absent.`,
    { grantId }
  )
}

function parseReceipt<T>(schema: z.ZodType<T>, grantId: string, receipt: string): T {
  let raw: unknown
  try {
    raw = JSON.parse(receipt)
  } catch {
    return invalidGrantRecord(grantId, 'not JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return invalidGrantRecord(grantId, parsed.error.issues[0]?.message ?? 'schema mismatch')
  }
  return parsed.data
}

const grantRow = z.object({ grant_id: z.string(), receipt: z.string() })
const bindingRow = z.object({ grant_id: z.string(), run_id: z.string(), receipt: z.string() })
const revocationRow = z.object({ grant_id: z.string(), receipt: z.string() })

type GrantDb = Pick<OrchestrationDb, 'db'>

export function readStartGrant(db: GrantDb, grantId: string): StartGrant | undefined {
  const row = db.db.prepare('SELECT grant_id, receipt FROM start_grants WHERE grant_id = ?').get(grantId)
  if (!row) {
    return undefined
  }
  const parsed = grantRow.parse(row)
  return parseReceipt(startGrantSchema, parsed.grant_id, parsed.receipt)
}

export function readStartGrantRevocation(
  db: GrantDb,
  grantId: string
): StartGrantRevocation | undefined {
  const row = db.db
    .prepare('SELECT grant_id, receipt FROM start_grant_revocations WHERE grant_id = ?')
    .get(grantId)
  if (!row) {
    return undefined
  }
  const parsed = revocationRow.parse(row)
  return parseReceipt(startGrantRevocationSchema, parsed.grant_id, parsed.receipt)
}

export function readStartGrantBinding(
  db: GrantDb,
  selector: { grantId: string } | { runId: string }
): StartGrantBinding | undefined {
  const row =
    'grantId' in selector
      ? db.db
          .prepare('SELECT grant_id, run_id, receipt FROM start_grant_runs WHERE grant_id = ?')
          .get(selector.grantId)
      : db.db
          .prepare('SELECT grant_id, run_id, receipt FROM start_grant_runs WHERE run_id = ?')
          .get(selector.runId)
  if (!row) {
    return undefined
  }
  const parsed = bindingRow.parse(row)
  const binding = parseReceipt(startGrantBindingSchema, parsed.grant_id, parsed.receipt)
  // The columns are the index and the receipt is the record; a disagreement means one of them was
  // written by something that is not this module, so the pair is unusable rather than half-trusted.
  if (binding.grantId !== parsed.grant_id || binding.runId !== parsed.run_id) {
    return invalidGrantRecord(parsed.grant_id, 'binding columns disagree with its receipt')
  }
  return binding
}

/**
 * The grant covering a Run, or `undefined` when the Run has none.
 *
 * A binding whose grant row is missing throws instead of returning `undefined`: with `foreign_keys`
 * off (the node driver) that state is reachable, and reading it as "not granted" would be exactly the
 * fail-open this design exists to remove.
 */
export function readGrantForRun(db: GrantDb, runId: string): StartGrant | undefined {
  const binding = readStartGrantBinding(db, { runId })
  if (!binding) {
    return undefined
  }
  const grant = readStartGrant(db, binding.grantId)
  if (!grant) {
    return invalidGrantRecord(binding.grantId, 'binding exists without its grant')
  }
  return grant
}

/** Inserts are the only writes: the schema's triggers refuse every update and delete. */
export function insertStartGrant(db: GrantDb, grant: StartGrant): void {
  const record = startGrantSchema.parse(grant)
  db.db
    .prepare('INSERT INTO start_grants (grant_id, receipt) VALUES (?, ?)')
    .run(record.grantId, JSON.stringify(record))
}

export function bindStartGrantToRun(
  db: GrantDb,
  params: { grantId: string; runId: string; boundAuthority: StartGrant['minter'] }
): void {
  const record = startGrantBindingSchema.parse({
    grantId: params.grantId,
    runId: params.runId,
    boundAt: new Date().toISOString(),
    boundAuthority: params.boundAuthority
  })
  db.db
    .prepare('INSERT INTO start_grant_runs (grant_id, run_id, receipt) VALUES (?, ?, ?)')
    .run(record.grantId, record.runId, JSON.stringify(record))
}

export function insertStartGrantRevocation(db: GrantDb, revocation: StartGrantRevocation): void {
  const record = startGrantRevocationSchema.parse(revocation)
  db.db
    .prepare('INSERT INTO start_grant_revocations (grant_id, receipt) VALUES (?, ?)')
    .run(record.grantId, JSON.stringify(record))
}
