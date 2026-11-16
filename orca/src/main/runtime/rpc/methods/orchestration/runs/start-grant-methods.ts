import { defineMethod } from '../../../core'
import { hashCanonical } from '../../../orchestration-mutation-receipt'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  insertStartGrant,
  startGrantSchema,
  startGrantSubmittedSchema,
  insertStartGrantRevocation,
  readStartGrant,
  readStartGrantBinding,
  readStartGrantRevocation,
  type StartGrant
} from '../../../../orchestration/start-grant-policy'
import { requireStrictTerminalCaller } from '../../../strict-coordinator-authority'
import { grantActiveWorkers } from '../../../../orchestration/start-grant-spawn'
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
      const submitted = params.record
      if (submitted !== null && typeof submitted === 'object' && 'minter' in submitted) {
        throw new OrchestrationError(
          'start_grant_invalid_record',
          'A start grant record must not name its minter: the server writes the verified live caller, because a caller cannot read its own launch token.',
          {}
        )
      }
      const parsed = startGrantSubmittedSchema.safeParse(submitted)
      if (!parsed.success) {
        throw new OrchestrationError(
          'start_grant_invalid_record',
          `The grant record is not valid: ${parsed.error.issues[0]?.path.join('.') ?? 'shape'} ${
            parsed.error.issues[0]?.message ?? ''
          }`.trim(),
          { issues: parsed.error.issues.map((issue) => issue.path.join('.')) }
        )
      }
      const complete = startGrantSchema.safeParse({ ...parsed.data, minter: authority })
      if (!complete.success) {
        throw new OrchestrationError(
          'start_grant_invalid_record',
          `The grant record is not valid: ${
            complete.error.issues[0]?.message ?? 'shape'
          }`,
          { issues: complete.error.issues.map((issue) => issue.path.join('.')) }
        )
      }
      const record: StartGrant = complete.data
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
    // The same number the spawn path counts, so "why was the 9th Worker refused" is answerable here.
    workers: { active: grantActiveWorkers(db, grant.grantId), max: grant.maxWorkers },
    effectsApplied: false as const
  }
}
