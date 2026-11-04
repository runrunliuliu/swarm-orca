import { defineMethod } from '../../../core'
import { RunRetireStrictParams } from '../../../../../../shared/rpc-contract/orchestration-runs-params'
import {
  strictCoordinatorRefusal,
  strictRunRetirement
} from '../../../../orchestration/strict-coordinator-policy'
import { assertStrictRetirementCaller } from '../../../strict-coordinator-retirement-authority'
import { assertStrictCoordinator } from '../../../strict-coordinator-authority'
import { hashCanonical } from '../../../orchestration-mutation-receipt'
import {
  strictRetirementInventory,
  assertStrictRetirementSettled,
  strictRetirementProcesses
} from '../../../../orchestration/strict-retirement-inventory'

export const STRICT_RUN_RETIRE_METHODS = [
  defineMethod({
    name: 'orchestration.runRetireStrict',
    params: RunRetireStrictParams,
    handler: async (params, ctx) => {
      assertStrictRetirementCaller(ctx, params.run, params.from)
      const db = ctx.runtime.getOrchestrationDb()
      const prior = strictRunRetirement(db, params.run)
      if (prior !== undefined) {
        return prior
      }
      assertStrictCoordinator(ctx, params.run)
      const run = db.getRun(params.run)!
      if (run.consumer_generation !== params.generation) {
        strictCoordinatorRefusal(params.run, 'retirement generation changed')
      }
      // Pending receipts lack reliable Run scope; conservatively block instead of losing unknown effects.
      const assertNoPending = () => {
        if (
          db.db
            .prepare(`SELECT 1 FROM mutation_receipts WHERE state = 'pending'
        AND NOT (caller_fingerprint = ? AND request_id = ?) LIMIT 1`)
            .get(
              ctx.orchestrationMutation?.callerFingerprint ?? '',
              ctx.orchestrationMutation?.requestId ?? ''
            )
        ) {
          strictCoordinatorRefusal(
            params.run,
            'reconcile pending mutation receipts before retirement'
          )
        }
      }
      assertNoPending()
      const inventory = strictRetirementInventory(db, params.run)
      assertStrictRetirementSettled(inventory, params.run)
      const processes = strictRetirementProcesses(inventory, params.run)
      for (const process of processes) {
        const verdict = await ctx.runtime.inspectTerminalProcessIncarnationLiveness(
          process.process_incarnation,
          process.host_scope
        )
        if (verdict !== 'exited') {
          strictCoordinatorRefusal(
            params.run,
            `Worker process is ${verdict}; retirement requires host-proven exited`
          )
        }
      }
      assertStrictCoordinator(ctx, params.run)
      db.db.exec('BEGIN IMMEDIATE')
      try {
        assertNoPending()
        if (hashCanonical(inventory) !== hashCanonical(strictRetirementInventory(db, params.run))) {
          strictCoordinatorRefusal(params.run, 'inventory changed during retirement inspection')
        }
        const receipt = {
          runId: params.run,
          coordinatorPolicy: 'strict-v1',
          coordinatorState: 'retired',
          generation: params.generation + 1,
          decision: params.decision,
          retiredAt: new Date().toISOString(),
          exitedProcesses: processes,
          externalJobsVerified: false
        }
        db.db
          .prepare(
            'INSERT INTO strict_run_retirements (run_id, generation, receipt) VALUES (?, ?, ?)'
          )
          .run(params.run, params.generation, JSON.stringify(receipt))
        db.routeAllUnreadDirectMessagesToRunMailbox(params.run, params.from)
        const updated = db.db
          .prepare(`UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
        coordinator_orca_session_id = NULL, coordinator_orca_session_id_generation = NULL,
        consumer_generation = consumer_generation + 1, updated_at = datetime('now')
        WHERE id = ? AND consumer_generation = ?`)
          .run(params.run, params.generation)
        if (updated.changes !== 1) {
          strictCoordinatorRefusal(params.run, 'retirement generation changed')
        }
        db.fenceUnacknowledgedMailboxDeliveries(`run:${params.run}`)
        // Persist the outcome with the fence so a lost response cannot strand a pending request.
        ctx.recordMutationReceipt?.(receipt)
        db.db.exec('COMMIT')
        ctx.runtime.cancelMessageWaiters(`run:${params.run}`)
        return receipt
      } catch (error) {
        if (db.db.isTransaction) {
          db.db.exec('ROLLBACK')
        }
        throw error
      }
    }
  })
]
