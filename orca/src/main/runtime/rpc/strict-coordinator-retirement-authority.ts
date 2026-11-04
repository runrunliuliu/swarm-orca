import type { RpcContext } from './core'
import { requireStrictTerminalCaller } from './strict-coordinator-authority'
import {
  strictCoordinatorPolicy,
  strictCoordinatorRefusal
} from '../orchestration/strict-coordinator-policy'
import { hashCanonical } from './orchestration-mutation-receipt'
import { isEquivalentPaneKey } from '../orchestration/db/pane-key-match'

export function assertStrictRetirementCaller(
  ctx: RpcContext,
  runId: string,
  declared?: string
): void {
  const policy = strictCoordinatorPolicy(ctx.runtime.getOrchestrationDb(), runId)
  const proof = requireStrictTerminalCaller(
    ctx.runtime,
    ctx.orchestrationCompatibilityEvidence,
    declared
  )
  if (
    !policy ||
    proof.terminalHandle !== policy.authority.terminalHandle ||
    proof.processIncarnation !== policy.authority.processIncarnation ||
    proof.launchTokenHash !== policy.authority.launchTokenHash ||
    !isEquivalentPaneKey(proof.paneKey, policy.authority.paneKey) ||
    hashCanonical(proof.hostScope) !== hashCanonical(policy.authority.hostScope)
  ) {
    strictCoordinatorRefusal(
      runId,
      'only the original live Coordinator can retire or replay retirement'
    )
  }
}
