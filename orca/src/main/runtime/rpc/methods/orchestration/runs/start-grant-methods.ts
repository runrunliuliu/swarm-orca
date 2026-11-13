import { defineMethod } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { hashCanonical } from '../../../orchestration-mutation-receipt'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  insertStartGrant,
  insertStartGrantRevocation,
  readStartGrant,
  readStartGrantBinding,
  readStartGrantRevocation,
  startGrantSchema,
  type StartGrant
} from '../../../../orchestration/start-grant-policy'
import { requireStrictTerminalCaller } from '../../../strict-coordinator-authority'
import {
  StartGrantMintParams,
  StartGrantRevokeParams,
  StartGrantShowParams
} from '../../../../../../shared/rpc-contract/orchestration-start-grant-params'

/**
 * The grant's own lifecycle. Minting is the only way a grant comes into existence, and it is not a
 * gate: the record says who approved what, because the caller had to prove a live terminal identity
 * to write it. Nothing here can be edited afterwards — a revocation is a second row.
 */
export const START_GRANT_METHODS = [
  defineMethod({
    name: 'orchestration.startGrantMint',
    params: StartGrantMintParams,
    handler: (params, ctx) => {
      const authority = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence,
        params.from
      )
      const parsed = startGrantSchema.safeParse(params.record)
      if (!parsed.success) {
        throw new OrchestrationError(
          'start_grant_invalid_record',
          `The grant record is not valid: ${parsed.error.issues[0]?.path.join('.') ?? 'shape'} ${
            parsed.error.issues[0]?.message ?? ''
          }`.trim(),
          { issues: parsed.error.issues.map((issue) => issue.path.join('.')) }
        )
      }
      const record = parsed.data
      // The server never lets a mint attribute itself to another terminal: the field is stored, so a
      // record naming a different minter would be an approval signed by someone who never called.
      if (hashCanonical(record.minter) !== hashCanonical(authority)) {
        throw new OrchestrationError(
          'start_grant_invalid_record',
          'The grant record names a different minter than this terminal; mint it as the terminal that holds the approval.',
          { grantId: record.grantId }
        )
      }
      const db = ctx.runtime.getOrchestrationDb()
      const existing = readStartGrant(db, record.grantId)
      if (existing) {
        // Same record under the same id is a retry; a different one is two approvals wearing one id,
        // and neither the audit nor the cap could tell which of them a Run was created under.
        if (hashCanonical(existing) === hashCanonical(record)) {
          return { grant: existing, effectsApplied: false }
        }
        throw new OrchestrationError(
          'start_grant_record_conflict',
          `Start grant ${record.grantId} already exists with different contents; a grant id names one approval.`,
          { grantId: record.grantId }
        )
      }
      insertStartGrant(db, record)
      return { grant: record, effectsApplied: true }
    }
  }),
  defineMethod({
    name: 'orchestration.startGrantShow',
    params: StartGrantShowParams,
    handler: (params, ctx) => {
      const db = ctx.runtime.getOrchestrationDb()
      const grant = readStartGrant(db, params.grant)
      if (!grant) {
        throw new OrchestrationError(
          'start_grant_unknown',
          `Start grant ${params.grant} does not exist.`,
          { grantId: params.grant }
        )
      }
      return exposeGrant(db, grant)
    }
  }),
  defineMethod({
    name: 'orchestration.startGrantRevoke',
    params: StartGrantRevokeParams,
    handler: (params, ctx) => {
      const authority = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence,
        params.from
      )
      const db = ctx.runtime.getOrchestrationDb()
      const grant = readStartGrant(db, params.grant)
      if (!grant) {
        throw new OrchestrationError(
          'start_grant_unknown',
          `Start grant ${params.grant} does not exist.`,
          { grantId: params.grant }
        )
      }
      const existing = readStartGrantRevocation(db, grant.grantId)
      if (existing) {
        const sameIntent =
          existing.reason === params.reason &&
          hashCanonical(existing.authority) === hashCanonical(authority)
        if (sameIntent) {
          return { revocation: existing, effectsApplied: false }
        }
        throw new OrchestrationError(
          'start_grant_record_conflict',
          `Start grant ${grant.grantId} is already revoked at ${existing.revokedAt} for a different reason; a withdrawal is recorded once.`,
          { grantId: grant.grantId, revokedAt: existing.revokedAt }
        )
      }
      const revocation = {
        schemaVersion: 1 as const,
        kind: 'start_grant_revocation' as const,
        grantId: grant.grantId,
        revokedAt: new Date().toISOString(),
        authority,
        reason: params.reason,
        executionAuthorized: false as const
      }
      insertStartGrantRevocation(db, revocation)
      return { revocation, effectsApplied: true }
    }
  })
]

function exposeGrant(db: OrchestrationDb, grant: StartGrant) {
  const revocation = readStartGrantRevocation(db, grant.grantId)
  const binding = readStartGrantBinding(db, { grantId: grant.grantId })
  return {
    grant,
    state: {
      // Derived at read time from the server clock, never stored: a stored "valid" flag would be a
      // claim about the past that the next request could not rely on.
      valid: revocation === undefined && Date.now() <= Date.parse(grant.deadline),
      expired: Date.now() > Date.parse(grant.deadline),
      revoked: revocation !== undefined,
      ...(revocation ? { revokedAt: revocation.revokedAt, revokedReason: revocation.reason } : {})
    },
    run: binding ? { id: binding.runId, boundAt: binding.boundAt } : null,
    effectsApplied: false as const
  }
}
