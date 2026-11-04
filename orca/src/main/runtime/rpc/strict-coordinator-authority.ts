import type { RpcContext } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import {
  hasStrictCoordinatorRuns,
  strictCoordinatorPolicy,
  strictCoordinatorRefusal,
  strictRunRetirement,
  strictWorkerRunIds
} from '../orchestration/strict-coordinator-policy'
import { resolveOrchestrationParty } from '../orchestration/orchestration-party'
import { isEquivalentPaneKey } from '../orchestration/db/pane-key-match'
import { hashCanonical } from './orchestration-mutation-receipt'
import { assertNoAdministrativeHistoryFence } from '../orchestration/administrative-history-fence'

export function requireStrictTerminalCaller(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | undefined,
  declared?: string
) {
  const proof = runtime.verifyOrchestrationCompatibilityCaller(evidence, {
    currentRuntimeLaunchSufficient: true
  })
  if (!proof || (declared !== undefined && proof.terminalHandle !== declared)) {
    strictCoordinatorRefusal(
      'strict',
      'a live native terminal caller proof is required (a --from handle is not proof)'
    )
  }
  return proof
}

export function assertStrictCoordinator(ctx: RpcContext, runId: string): void {
  const db = ctx.runtime.getOrchestrationDb()
  const policy = strictCoordinatorPolicy(db, runId)
  if (!policy) {
    return
  }
  const run = db.getRun(runId)
  const proof = requireStrictTerminalCaller(ctx.runtime, ctx.orchestrationCompatibilityEvidence)
  const expected = policy.authority
  if (
    !run ||
    strictRunRetirement(db, runId) !== undefined ||
    run.consumer_generation !== 1 ||
    run.coordinator_handle !== expected.terminalHandle ||
    proof.terminalHandle !== expected.terminalHandle ||
    proof.processIncarnation !== expected.processIncarnation ||
    proof.launchTokenHash !== expected.launchTokenHash ||
    !isEquivalentPaneKey(proof.paneKey, expected.paneKey) ||
    hashCanonical(proof.hostScope) !== hashCanonical(expected.hostScope)
  ) {
    strictCoordinatorRefusal(
      runId,
      'only the pinned, current Coordinator may perform this operation'
    )
  }
}

export function strictTargetRunIds(
  runtime: OrcaRuntimeService,
  address: string,
  includeRetired = false
): string[] {
  const db = runtime.getExistingOrchestrationDb?.()
  if (!db || !hasStrictCoordinatorRuns(db)) {
    return []
  }
  if (address.startsWith('dispatch:')) {
    const dispatch = db.getDispatchContextById(address.slice('dispatch:'.length))
    return dispatch && strictCoordinatorPolicy(db, dispatch.run_id) ? [dispatch.run_id] : []
  }
  if (address.startsWith('run:')) {
    return []
  }
  const party = resolveOrchestrationParty(address, db)
  return strictWorkerRunIds(
    db,
    {
      handle: party.terminalHandle,
      paneKey: party.terminalHandle ? runtime.getTerminalPaneKey(party.terminalHandle) : null,
      sessionId: party.orcaSessionId
    },
    includeRetired
  )
}

export function assertStrictRecipient(
  ctx: RpcContext,
  address: string,
  includeRetired = false
): void {
  const db = ctx.runtime.getExistingOrchestrationDb?.()
  if (db?.hasAdministrativeHistoryFences) {
    const pane = address.startsWith('term_') ? ctx.runtime.getTerminalPaneKey(address) : null
    assertNoAdministrativeHistoryFence(db, [address], pane ? [pane] : [])
  }
  for (const runId of strictTargetRunIds(ctx.runtime, address, includeRetired)) {
    assertStrictCoordinator(ctx, runId)
  }
}

export function assertStrictReplayRecipient(
  ctx: RpcContext,
  target: { to: string; runId?: string }
): void {
  assertStrictRecipient(ctx, target.to)
  if (target.runId) {
    assertStrictRecipient(ctx, target.runId)
  }
  // Old receipts without a scope cannot prove they belong to later work on a reused pane.
  for (const runId of strictTargetRunIds(ctx.runtime, target.to, true)) {
    if (target.runId === undefined || target.runId === runId) {
      assertStrictCoordinator(ctx, runId)
    }
  }
}

export function assertStrictDispatchWorker(runtime: OrcaRuntimeService, dispatchId: string): void {
  const db = runtime.getExistingOrchestrationDb?.()
  const dispatch = db?.getDispatchContextById(dispatchId)
  if (!db || !dispatch || !strictCoordinatorPolicy(db, dispatch.run_id)) {
    return
  }
  const worker = dispatch.assignee_handle
    ? runtime.getOrchestrationDispatchAuthority(dispatch.assignee_handle)
    : null
  if (
    !worker?.paneKey ||
    !dispatch.assignee_pane_key ||
    !worker.launchTokenHash ||
    worker.launchTokenHash !== dispatch.launch_token_hash ||
    worker.processIncarnation !== dispatch.process_incarnation ||
    !isEquivalentPaneKey(worker.paneKey, dispatch.assignee_pane_key) ||
    !dispatch.host_scope ||
    hashCanonical(worker.hostScope) !== hashCanonical(JSON.parse(dispatch.host_scope))
  ) {
    strictCoordinatorRefusal(dispatch.run_id, 'Worker launch identity changed before delivery')
  }
  const policy = strictCoordinatorPolicy(db, dispatch.run_id)!
  if (isEquivalentPaneKey(worker.paneKey, policy.authority.paneKey)) {
    strictCoordinatorRefusal(dispatch.run_id, 'the Coordinator pane cannot also be a Worker')
  }
}

export function assertNoStrictRawInput(runtime: OrcaRuntimeService, address: string): void {
  const db = runtime.getExistingOrchestrationDb?.()
  if (db?.hasAdministrativeHistoryFences) {
    const pane = address.startsWith('term_') ? runtime.getTerminalPaneKey(address) : null
    assertNoAdministrativeHistoryFence(db, [address], pane ? [pane] : [])
  }
  for (const runId of strictTargetRunIds(runtime, address)) {
    strictCoordinatorRefusal(
      runId,
      'raw Worker input is disabled; its Coordinator must use orchestration send/reply/dispatch'
    )
  }
}
