import { z } from 'zod'
import type { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import type { RpcContext } from '../runtime/rpc/core'
import { requireStrictTerminalCaller } from '../runtime/rpc/strict-coordinator-authority'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import {
  strictCoordinatorPolicy,
  strictTerminalAuthoritySchema
} from '../runtime/orchestration/strict-coordinator-policy'
import { PlannedSource, RestartFileRef, readRestartRef } from './orcad-planned-source'

const Phase = z.enum([
  'prepare',
  'apply',
  'begin',
  'finish',
  'complete',
  'run',
  'verify',
  'continue-begin',
  'continue-finish',
  'turn-end',
  'source-prepare'
])
const Transition = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('planned-restart-monitor-transition'),
    old_plan: RestartFileRef,
    source_runtime: z.string(),
    target_runtime: z.string(),
    server_id: z.string(),
    seal: RestartFileRef,
    binding: z.unknown(),
    snapshot: z.unknown()
  })
  .strict()
const Request = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('transition'), seal: RestartFileRef }).strict(),
  z
    .object({
      phase: z.literal('boundary'),
      transition: Transition,
      operation: Phase,
      evidence: z.unknown().optional()
    })
    .strict()
])

/** This binds transport to a consumed native restart, not a new role or execution grant. */
export function plannedRestartTargetMaintenance(
  lineage: ReturnType<typeof openOrcadRuntimeLineage>
) {
  return async (input: unknown, ctx: RpcContext) => {
    const request = Request.parse(input)
    const { preparation, review, consumption } = lineage.plannedRestart.continuation()
    const proposal = PlannedSource.parse(preparation.proposal)
    const caller = strictTerminalAuthoritySchema.parse(
      requireStrictTerminalCaller(ctx.runtime, ctx.orchestrationCompatibilityEvidence)
    )
    const phase = request.phase === 'boundary' ? request.operation : 'prepare'
    const expected = ['begin', 'finish', 'continue-begin', 'continue-finish', 'turn-end'].includes(
      phase
    )
      ? strictCoordinatorPolicy(ctx.runtime.getOrchestrationDb(), preparation.runId)?.authority
      : ['run', 'verify'].includes(phase)
        ? preparation.sender
        : preparation.preparer
    if (
      !expected ||
      hashCanonical(caller) !== hashCanonical(expected) ||
      consumption.target.runtimeId !== ctx.runtime.getRuntimeId()
    ) {
      throw new Error('planned_restart_wrong_caller')
    }
    const sealRef = request.phase === 'boundary' ? request.transition.seal : request.seal
    const sealed = z
      .object({
        seal: z
          .object({ runId: z.string(), databaseId: z.string(), sourceRuntimeId: z.string() })
          .passthrough(),
        sealCanonicalSha256: z.string()
      })
      .passthrough()
      .parse(readRestartRef(sealRef))
    if (
      hashCanonical(sealed.seal) !== review.seal.sealCanonicalSha256 ||
      sealed.sealCanonicalSha256 !== review.seal.sealCanonicalSha256 ||
      sealed.seal.runId !== preparation.runId ||
      sealed.seal.databaseId !== review.seal.databaseId ||
      sealed.seal.sourceRuntimeId !== preparation.source.runtimeId
    ) {
      throw new Error('planned_restart_seal_changed')
    }
    const transition = {
      schema_version: 1,
      kind: 'planned-restart-monitor-transition',
      old_plan: proposal.plan,
      source_runtime: preparation.source.runtimeId,
      target_runtime: consumption.target.runtimeId,
      server_id: consumption.target.serverId,
      seal: sealRef,
      binding: proposal.binding,
      snapshot: proposal.snapshot
    }
    if (request.phase === 'transition') {
      return transition
    }
    if (hashCanonical(request.transition) !== hashCanonical(transition)) {
      throw new Error('planned_restart_transition_changed')
    }
    return { transition_canonical_sha256: hashCanonical(transition), phase: request.operation }
  }
}
