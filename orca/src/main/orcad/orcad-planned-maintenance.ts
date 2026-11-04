import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RpcContext } from '../runtime/rpc/core'
import { requireStrictTerminalCaller } from '../runtime/rpc/strict-coordinator-authority'
import { freezePlannedRestartRequests } from '../runtime/rpc/planned-restart-admission'
import {
  strictCoordinatorPolicy,
  strictTerminalAuthoritySchema
} from '../runtime/orchestration/strict-coordinator-policy'
import { assertPlannedTerminal } from './orcad-planned-restart-records'
import { sealStrictContinuityDatabase } from '../runtime/orchestration/strict-continuity-store'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { getDaemonProvider } from '../daemon/daemon-provider-state'
import {
  checkPlannedSource,
  plannedSourceScope,
  PlannedSource,
  readRestartRef,
  RestartFileRef
} from './orcad-planned-source'
import { plannedRestartTargetMaintenance } from './orcad-planned-target'
import type { openOrcadRuntimeLineage } from './orcad-runtime-lineage'

const Sha = z.string().regex(/^[a-f0-9]{64}$/)
const Request = z.discriminatedUnion('phase', [
  z
    .object({
      phase: z.literal('prepare'),
      runId: z.string().min(1),
      sender: z.string().min(1),
      proposalCanonicalSha256: Sha,
      proposal: z.record(z.string(), z.unknown())
    })
    .strict(),
  z
    .object({
      phase: z.literal('seal'),
      preparationCanonicalSha256: Sha,
      expiresAtMs: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      phase: z.literal('review'),
      seal: z
        .object({
          runId: z.string().min(1),
          databaseId: z.string().uuid(),
          sealCanonicalSha256: Sha
        })
        .strict(),
      proposalCanonicalSha256: Sha,
      approved: z.boolean(),
      reason: z.string().min(1)
    })
    .strict()
])

/** Registered only by the instance-lock owner. Seal errors intentionally leave writers stopped. */
export function plannedRestartSourceMaintenance(
  lineage: ReturnType<typeof openOrcadRuntimeLineage>,
  freezeProfile: () => Promise<void>
) {
  let sealing = false
  let sealed: ReturnType<typeof sealStrictContinuityDatabase> | undefined
  let sealRequestSha: string | undefined
  async function checkSource(ctx: RpcContext, input: unknown, runId: string, sender: string) {
    const proposal = PlannedSource.parse(input)
    const plan = z
      .object({ recovery: z.object({ transition: RestartFileRef }).optional() })
      .passthrough()
      .parse(readRestartRef(proposal.plan))
    let runtime: string | undefined
    if (plan.recovery) {
      const transition = readRestartRef(plan.recovery.transition)
      await plannedRestartTargetMaintenance(lineage)(
        { phase: 'boundary', transition, operation: 'source-prepare' },
        ctx
      )
      runtime = ctx.runtime.getRuntimeId()
    }
    checkPlannedSource(ctx, input, runId, sender, runtime)
  }
  return async (input: unknown, ctx: RpcContext) => {
    const request = Request.parse(input)
    const caller = requireStrictTerminalCaller(ctx.runtime, ctx.orchestrationCompatibilityEvidence)
    if (request.phase === 'review') {
      return lineage.plannedRestart.review(ctx, request)
    }
    const adapter = getDaemonProvider()
    if (!(adapter instanceof DaemonPtyAdapter)) {
      throw new Error('planned_restart_requires_single_daemon')
    }
    if (request.phase === 'prepare') {
      if (sealing) {
        throw new Error('planned_restart_already_sealing')
      }
      const daemon = adapter.getDaemonIdentity()
      if (!daemon) {
        throw new Error('planned_restart_daemon_identity_unavailable')
      }
      // Reuse the original pin on a lost response, never invent another transition.
      const pin = lineage.plannedRestart.existingPreparation()?.daemon
      await checkSource(ctx, request.proposal, request.runId, request.sender)
      return lineage.plannedRestart.prepare(ctx, {
        runId: request.runId,
        sender: request.sender,
        proposalCanonicalSha256: request.proposalCanonicalSha256,
        proposal: request.proposal,
        daemon: pin ?? { daemon, transitionId: randomUUID(), token: randomUUID() }
      })
    }
    const preparation = lineage.plannedRestart.preparation()
    if (
      hashCanonical(preparation) !== request.preparationCanonicalSha256 ||
      hashCanonical(strictTerminalAuthoritySchema.parse(caller)) !==
        hashCanonical(preparation.preparer) ||
      !preparation.daemon
    ) {
      throw new Error('planned_restart_preparation_mismatch')
    }
    if (sealed && sealRequestSha === hashCanonical(request)) {
      return sealed
    }
    if (sealing) {
      throw new Error('planned_restart_seal_incomplete_preserve_evidence')
    }
    const coordinator = strictTerminalAuthoritySchema.parse(
      strictCoordinatorPolicy(ctx.runtime.getOrchestrationDb(), preparation.runId)?.authority
    )
    assertPlannedTerminal(ctx.runtime, coordinator)
    const idle = await ctx.runtime.waitForTerminal(coordinator.terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: 250
    })
    if (!idle.satisfied) {
      throw new Error('planned_restart_coordinator_not_idle')
    }
    freezePlannedRestartRequests(ctx.runtime)
    sealing = true
    await adapter.plannedRestart('Freeze', preparation.daemon)
    await freezeProfile()
    const frozenIdle = await ctx.runtime.waitForTerminal(coordinator.terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: 250
    })
    if (!frozenIdle.satisfied) {
      throw new Error('planned_restart_coordinator_not_idle_after_freeze')
    }
    const db = ctx.runtime.getOrchestrationDb()
    await checkSource(
      ctx,
      preparation.proposal,
      preparation.runId,
      preparation.sender.terminalHandle
    )
    lineage.recordSourceInventory(plannedSourceScope(preparation.proposal))
    const result = sealStrictContinuityDatabase(db, {
      runId: preparation.runId,
      sourceRuntimeId: ctx.runtime.getRuntimeId(),
      expiresAtMs: request.expiresAtMs
    })
    // Also stops background/direct SQLite writers, not just RPC handlers.
    db.db.pragma('query_only = ON')
    lineage.recordDatabaseSeal(db, {
      runId: result.seal.runId,
      databaseId: result.seal.databaseId,
      sealCanonicalSha256: result.sealCanonicalSha256
    })
    sealRequestSha = hashCanonical(request)
    sealed = result
    return result
  }
}
