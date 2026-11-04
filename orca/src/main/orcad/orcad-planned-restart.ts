import type { z } from 'zod'
import type Database from '../sqlite/sync-database'
import type { RpcContext } from '../runtime/rpc/core'
import { requireStrictTerminalCaller } from '../runtime/rpc/strict-coordinator-authority'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import {
  strictCoordinatorPolicy,
  strictTerminalAuthoritySchema
} from '../runtime/orchestration/strict-coordinator-policy'
import {
  assertNoStrictContinuitySeal,
  verifyStrictContinuityDatabase
} from '../runtime/orchestration/strict-continuity-store'
import {
  bindStrictContinuityResume,
  activateStrictContinuityResume
} from '../runtime/orchestration/strict-continuity-resume'
import { getRun, getRunRaw } from '../runtime/orchestration/db/runs/run-lookup'
import { preparePlannedRestartLineageSchema } from './orcad-runtime-lineage-schema'
import type { runtimeLineageSeals } from './orcad-runtime-lineage-seals'
import type { OrcadRuntimeBoot } from './orcad-runtime-lineage-records'
import type { DaemonRestartPinSchema } from '../daemon/daemon-planned-restart-client'
import {
  Preparation,
  Review,
  Consumption,
  assertPlannedTerminal,
  samePlannedActor as sameActor,
  plannedRestartRecords,
  refuseRestart as refuse
} from './orcad-planned-restart-records'
type Pins = z.infer<typeof Review>['seal']

/** Native journal operations only; the public maintenance lifecycle must provide its writer fence. */
export function plannedRestartJournal(options: {
  journal: Database.Database
  current: () => OrcadRuntimeBoot
  transaction: <T>(operation: () => T) => T
  appendBoot: (runtimeId: string, nowMs: number) => OrcadRuntimeBoot
  seals: ReturnType<typeof runtimeLineageSeals>
  assertSuccessor: (source: OrcadRuntimeBoot, target: OrcadRuntimeBoot) => unknown
}) {
  const { journal, current, transaction, appendBoot, seals, assertSuccessor } = options
  const records = plannedRestartRecords(journal)
  const read = (stage: 'prepare' | 'review' | 'attempt' | 'consume') => {
    const cycle = records.latestCycle()
    return cycle ? records.read(cycle, stage) : undefined
  }
  return {
    preparation() {
      return Preparation.parse(read('prepare'))
    },
    existingPreparation() {
      const value = read('prepare')
      if (!value) {
        return undefined
      }
      const preparation = Preparation.parse(value)
      return hashCanonical(preparation.source) === hashCanonical(current())
        ? preparation
        : undefined
    },
    continuation() {
      const cycle =
        records.continuationCycle(current().runtimeId) ?? refuse('committed continuation required')
      const consumption = Consumption.parse(records.read(cycle, 'consume'))
      if (hashCanonical(consumption.target) !== hashCanonical(current())) {
        refuse('successor no longer owns admission')
      }
      const review = Review.parse(records.read(cycle, 'review'))
      const preparation = Preparation.parse(records.read(cycle, 'prepare'))
      if (
        hashCanonical(review) !== consumption.reviewCanonicalSha256 ||
        hashCanonical(preparation) !== review.preparationCanonicalSha256
      ) {
        refuse('review pin mismatch')
      }
      return { preparation, review, consumption }
    },
    prepare(
      ctx: RpcContext,
      request: {
        runId: string
        sender: string
        proposalCanonicalSha256: string
        proposal?: Record<string, unknown>
        daemon?: z.infer<typeof DaemonRestartPinSchema>
      }
    ) {
      const source = current()
      if (request.proposal && hashCanonical(request.proposal) !== request.proposalCanonicalSha256) {
        refuse('proposal pin mismatch')
      }
      if (source.runtimeId !== ctx.runtime.getRuntimeId()) {
        refuse('preparation must run on the source Server')
      }
      const db = ctx.runtime.getOrchestrationDb()
      assertNoStrictContinuitySeal(db)
      const preparer = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence
      )
      const actualSender = ctx.runtime.getOrchestrationDispatchAuthority(request.sender)
      // Only a committed native transition supplies a restored sender's historical launch pin.
      const sender = strictTerminalAuthoritySchema.parse(
        actualSender?.launchTokenHash ? actualSender : this.continuation().preparation.sender
      )
      if (sender.terminalHandle !== request.sender) {
        refuse('sender changed')
      }
      assertPlannedTerminal(ctx.runtime, sender)
      const policy = strictCoordinatorPolicy(db, request.runId)
      if (!policy || sameActor(preparer, policy.authority) || sameActor(sender, policy.authority)) {
        refuse('preparation and sender must be outside the Coordinator')
      }
      const preparation = Preparation.parse({
        schemaVersion: 1,
        source,
        ...request,
        preparer,
        sender
      })
      return transaction(() => {
        preparePlannedRestartLineageSchema(journal)
        const cycle = hashCanonical(source)
        const previous = records.read(cycle, 'prepare')
        const latest = read('prepare')
        if (latest && (!previous || hashCanonical(latest) !== hashCanonical(previous))) {
          const prior = Consumption.parse(read('consume'))
          if (hashCanonical(prior.target) !== cycle) {
            refuse('previous cycle not committed by this runtime')
          }
        }
        if (previous && hashCanonical(previous) !== hashCanonical(preparation)) {
          refuse('preparation already pinned')
        }
        if (!previous) {
          records.insert(cycle, 'prepare', preparation)
        }
        return { preparation, preparationCanonicalSha256: hashCanonical(preparation) }
      })
    },
    review(
      ctx: RpcContext,
      request: {
        seal: Pins
        proposalCanonicalSha256: string
        approved: boolean
        reason: string
      },
      nowMs = Date.now()
    ) {
      const source = current()
      if (source.runtimeId !== ctx.runtime.getRuntimeId()) {
        refuse('review must run on the source Server')
      }
      const authority = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence
      )
      const db = ctx.runtime.getOrchestrationDb()
      const preparation = Preparation.parse(read('prepare'))
      if (
        hashCanonical(preparation.source) !== hashCanonical(source) ||
        preparation.runId !== request.seal.runId ||
        preparation.proposalCanonicalSha256 !== request.proposalCanonicalSha256
      ) {
        refuse('preparation pin mismatch')
      }
      const policy = strictCoordinatorPolicy(db, request.seal.runId)
      if (
        !policy ||
        [preparation.preparer, preparation.sender, policy.authority].some((actor) =>
          sameActor(actor, authority)
        )
      ) {
        refuse('independent reviewer required')
      }
      if (!request.approved) {
        refuse('review rejected')
      }
      const proof = verifyStrictContinuityDatabase(db, request.seal, nowMs)
      if (proof.seal.sourceRuntimeId !== source.runtimeId) {
        refuse('seal belongs to another runtime')
      }
      const review = Review.parse({
        schemaVersion: 1,
        source,
        seal: request.seal,
        proposalCanonicalSha256: request.proposalCanonicalSha256,
        preparationCanonicalSha256: hashCanonical(preparation),
        reviewerAuthoritySha256: hashCanonical(authority),
        reviewedAtMs: nowMs,
        reason: request.reason
      })
      return transaction(() => {
        const existing = read('review')
        if (existing) {
          const prior = Review.parse(existing)
          if (
            hashCanonical({ ...review, reviewedAtMs: prior.reviewedAtMs }) !== hashCanonical(prior)
          ) {
            refuse('review already recorded for a different request or caller')
          }
          return { review: prior, reviewCanonicalSha256: hashCanonical(prior) }
        }
        records.insert(hashCanonical(source), 'review', review)
        return { review, reviewCanonicalSha256: hashCanonical(review) }
      })
    },
    consume(
      db: Database.Database,
      request: {
        reviewCanonicalSha256: string
        proposalCanonicalSha256: string
        targetRuntimeId: string
        frozenDaemonRetry?: boolean
      },
      nowMs = Date.now()
    ) {
      const raw = { db, getRunRaw: (id: string) => getRunRaw.call({ db }, id) }
      const inspection = { db, getRun: (id: string) => getRun.call(raw, id) }
      const cycle = records.latestCycle() ?? refuse('preparation required')
      const consumption = transaction(() => {
        const review = Review.parse(read('review'))
        const preparation = Preparation.parse(read('prepare'))
        if (
          hashCanonical(review) !== request.reviewCanonicalSha256 ||
          review.proposalCanonicalSha256 !== request.proposalCanonicalSha256 ||
          hashCanonical(preparation) !== review.preparationCanonicalSha256 ||
          preparation.runId !== review.seal.runId ||
          hashCanonical(preparation.source) !== hashCanonical(review.source)
        ) {
          refuse('review pin mismatch')
        }
        const existing = read('attempt')
        if (existing) {
          const prior = Consumption.parse(existing)
          if (read('consume') && !request.frozenDaemonRetry) {
            refuse('receipt already consumed by another instance')
          }
          if (prior.target.runtimeId === request.targetRuntimeId) {
            if (hashCanonical(prior.target) !== hashCanonical(current())) {
              refuse('attempt no longer owns admission')
            }
            return prior
          }
        }
        const target = appendBoot(request.targetRuntimeId, nowMs)
        if (nowMs < review.reviewedAtMs) {
          refuse('review is from the future')
        }
        // Failed attempts remain in the boot chain, but none may have released database writes.
        const previous = existing ? Consumption.parse(existing).target : review.source
        assertSuccessor(previous, target)
        seals.inspectDatabaseSeal(inspection, review.seal, review.source, target, nowMs)
        const value = Consumption.parse({
          schemaVersion: 1,
          reviewCanonicalSha256: request.reviewCanonicalSha256,
          target
        })
        records.insert(hashCanonical(review.source), 'attempt', value, target.epoch)
        return value
      })
      // Bind only after the journal commit. A later connection still needs the same native instance.
      bindStrictContinuityResume(
        db,
        () => {
          if (
            hashCanonical(current()) !== hashCanonical(consumption.target) ||
            hashCanonical(records.read(cycle, 'attempt')) !== hashCanonical(consumption)
          ) {
            refuse('successor no longer owns admission')
          }
        },
        false
      )
      db.pragma('query_only = ON')
      return consumption
    },
    commit() {
      const attempt = Consumption.parse(read('attempt'))
      const cycle = hashCanonical(Preparation.parse(read('prepare')).source)
      transaction(() => {
        if (hashCanonical(attempt.target) !== hashCanonical(current())) {
          refuse('attempt no longer owns admission')
        }
        const prior = read('consume')
        if (!prior || hashCanonical(prior) !== hashCanonical(attempt)) {
          records.insert(cycle, 'consume', attempt, attempt.target.epoch)
        }
      })
    },
    activate(db: Database.Database) {
      const consumption = Consumption.parse(read('consume'))
      if (hashCanonical(consumption.target) !== hashCanonical(current())) {
        refuse('committed attempt required')
      }
      activateStrictContinuityResume(db)
      db.pragma('query_only = OFF')
    }
  }
}
