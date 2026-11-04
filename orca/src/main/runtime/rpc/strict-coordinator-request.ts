import type { RpcContext } from './core'
import { isOrchestrationMutation } from '../../../shared/orchestration-rpc-contract'
import { ORCHESTRATION_CALLER_PARAM } from './orchestration-session-caller'
import {
  hasStrictCoordinatorRuns,
  strictCoordinatorPolicy,
  strictCoordinatorRefusal
} from '../orchestration/strict-coordinator-policy'
import {
  assertNoStrictRawInput,
  assertStrictCoordinator,
  assertStrictRecipient,
  requireStrictTerminalCaller,
  strictTargetRunIds
} from './strict-coordinator-authority'
import { resolveOrchestrationParty } from '../orchestration/orchestration-party'
import { parseRemoteWorkerPayload } from './methods/orchestration/schemas'
import { isEquivalentPaneKey } from '../orchestration/db/pane-key-match'
import { hashCanonical } from './orchestration-mutation-receipt'
import { assertStrictRetirementCaller } from './strict-coordinator-retirement-authority'
import { assertNoAdministrativeHistoryFence } from '../orchestration/administrative-history-fence'
import { isStrictCoordinatorEffect, isStrictSessionEffect } from './strict-coordinator-effect-scope'
import { assertNoStrictContinuitySeal } from '../orchestration/strict-continuity-store'

// Runs before compatibility and durable replay in both transports; never trust the declared role.
export function assertStrictCoordinatorRequest(
  method: string,
  params: unknown,
  ctx: RpcContext
): void {
  const mailboxCheck = method === 'orchestration.check'
  if (!isStrictCoordinatorEffect(method, params)) {
    return
  }
  const db = ctx.runtime.getExistingOrchestrationDb?.()
  if (!db) {
    return
  }
  assertNoStrictContinuitySeal(db)
  const p: Record<string, unknown> = params && typeof params === 'object' ? { ...params } : {}
  const str = (key: string) => (typeof p[key] === 'string' ? p[key] : undefined)
  const addresses = [
    'from',
    'to',
    'terminal',
    'callerTerminalHandle',
    'sessionId',
    'run',
    'id',
    'dispatch',
    'dispatchId',
    'task'
  ].flatMap((key) => (str(key) ? [str(key)!] : []))
  const evidence = ctx.orchestrationCompatibilityEvidence
  if (evidence?.terminalHandle) {
    addresses.push(evidence.terminalHandle)
  }
  if (evidence?.agentSessionId) {
    addresses.push(evidence.agentSessionId)
  }
  const caller = ctx.orchestrationCaller
  if (caller) {
    addresses.push(caller.address, caller.orcaSessionId, caller.sessionId)
  }
  const panes = addresses
    .filter((address) => address.startsWith('term_'))
    .flatMap((address) => {
      const pane = ctx.runtime.getTerminalPaneKey(address)
      return pane ? [pane] : []
    })
  if (evidence?.paneKey) {
    panes.push(evidence.paneKey)
  }
  if (caller?.paneKey) {
    panes.push(caller.paneKey)
  }
  assertNoAdministrativeHistoryFence(db, addresses, panes)
  if (!hasStrictCoordinatorRuns(db)) {
    return
  }

  if (method === 'terminal.send') {
    if (str('terminal')) {
      assertNoStrictRawInput(ctx.runtime, str('terminal')!)
    }
    return
  }
  if (isStrictSessionEffect(method)) {
    if (str('sessionId')) {
      assertNoStrictRawInput(ctx.runtime, `session:${str('sessionId')}`)
    }
    return
  }
  if (!isOrchestrationMutation(method, params) && !mailboxCheck) {
    return
  }
  if (method === 'orchestration.reset') {
    strictCoordinatorRefusal('strict', 'reset is disabled while a strict Run exists')
  }
  // This narrow handler authenticates the original pin even after retirement for receipt replay.
  if (method === 'orchestration.runRetireStrict') {
    assertStrictRetirementCaller(ctx, str('run') ?? '', str('from'))
    return
  }

  const declared = str(ORCHESTRATION_CALLER_PARAM[method] ?? 'from')
  const party = declared ? resolveOrchestrationParty(declared, db) : undefined
  const current = party
    ? db.getCurrentRunForCoordinator({
        ...party,
        paneKey: party.terminalHandle ? ctx.runtime.getTerminalPaneKey(party.terminalHandle) : null
      })
    : undefined
  const claimed = ctx.orchestrationCompatibilityEvidence?.terminalHandle
  const senderRuns = [
    ...new Set(
      [declared, claimed].flatMap((handle) =>
        handle ? strictTargetRunIds(ctx.runtime, handle) : []
      )
    )
  ]
  const runIds = new Set<string>()
  if (str('run')) {
    runIds.add(str('run')!)
  }
  if (current) {
    runIds.add(current.id)
  }
  if (method === 'orchestration.runUse' && str('id')) {
    runIds.add(str('id')!)
  }
  const dispatchId = str('dispatch') ?? str('dispatchId')
  if (dispatchId) {
    const dispatch = db.getDispatchContextById(dispatchId)
    if (dispatch) {
      runIds.add(dispatch.run_id)
    }
  }
  if (method === 'orchestration.gateResolve' && str('id')) {
    const gate = db.getGate(str('id')!)
    if (gate) {
      runIds.add(gate.run_id)
    }
  }
  const taskId = str('task') ?? (method === 'orchestration.taskUpdate' ? str('id') : undefined)
  if (taskId) {
    const task = db.getTask(taskId)
    if (task) {
      runIds.add(task.run_id)
    }
  }

  if (method === 'orchestration.reply' && str('id')) {
    const original = db.getMessageById(str('id')!)
    if (original) {
      assertStrictRecipient(ctx, original.from_handle)
      if (db.getQuestion(original.id)) {
        assertStrictCoordinator(ctx, original.run_id)
      }
      if (!senderRuns.length) {
        assertStrictRecipient(ctx, original.to_handle)
      }
    }
  }
  if (
    [
      'orchestration.send',
      'orchestration.ask',
      'orchestration.check',
      'orchestration.reply'
    ].includes(method)
  ) {
    // Workers may report/read their own assignment, never start a child control plane.
    if (senderRuns.length) {
      const proof = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence,
        declared
      )
      const reportId =
        method === 'orchestration.send'
          ? parseRemoteWorkerPayload(str('payload')).dispatchId
          : undefined
      const dispatch =
        typeof reportId === 'string'
          ? db.getDispatchContextById(reportId)
          : (db.getActiveDispatchForIdentity(proof.terminalHandle, proof.paneKey) ??
            db.getLatestDispatchForTerminal(proof.terminalHandle))
      if (
        !dispatch ||
        dispatch.process_incarnation !== proof.processIncarnation ||
        dispatch.launch_token_hash !== proof.launchTokenHash ||
        !senderRuns.includes(dispatch.run_id) ||
        !dispatch.host_scope ||
        hashCanonical(proof.hostScope) !== hashCanonical(JSON.parse(dispatch.host_scope)) ||
        !dispatch.assignee_pane_key ||
        !isEquivalentPaneKey(dispatch.assignee_pane_key, proof.paneKey)
      ) {
        strictCoordinatorRefusal(
          senderRuns[0]!,
          'Worker caller does not match its Dispatch identity'
        )
      }
      if (method === 'orchestration.send' && str('to')) {
        const owner = db.getRun(dispatch.run_id)
        if (str('to') !== `run:${dispatch.run_id}` && str('to') !== owner?.coordinator_handle) {
          strictCoordinatorRefusal(
            dispatch.run_id,
            'Workers report to their owning Coordinator, not other Workers or Runs'
          )
        }
      }
      if (method === 'orchestration.reply' && str('id')) {
        const original = db.getMessageById(str('id')!)
        if (
          original &&
          original.to_handle !== proof.terminalHandle &&
          original.to_handle !== `dispatch:${dispatch.id}`
        ) {
          strictCoordinatorRefusal(dispatch.run_id, 'Workers may only reply to their own mailbox')
        }
      }
    } else if (current && strictCoordinatorPolicy(db, current.id)) {
      assertStrictCoordinator(ctx, current.id)
    }
    if (method === 'orchestration.send' && str('to') && !str('to')!.startsWith('@')) {
      assertStrictRecipient(ctx, str('to')!)
    }
    if (method === 'orchestration.check') {
      for (const runId of runIds) {
        if (!senderRuns.includes(runId)) {
          assertStrictCoordinator(ctx, runId)
        }
      }
    }
    return
  }
  for (const runId of senderRuns) {
    strictCoordinatorRefusal(runId, 'Workers cannot create or control another Run')
  }
  for (const target of [str('to'), str('terminal')]) {
    if (target && !target.startsWith('@')) {
      assertStrictRecipient(ctx, target)
    }
  }
  for (const runId of runIds) {
    assertStrictCoordinator(ctx, runId)
    if (strictCoordinatorPolicy(db, runId) && method === 'orchestration.runUse') {
      strictCoordinatorRefusal(
        runId,
        'strict-v1 does not support rebinding; keep using the pinned Run'
      )
    }
    if (method === 'orchestration.workerStart' && str('on') && strictCoordinatorPolicy(db, runId)) {
      strictCoordinatorRefusal(runId, 'cross-server strict Worker placement is not supported')
    }
  }
}
