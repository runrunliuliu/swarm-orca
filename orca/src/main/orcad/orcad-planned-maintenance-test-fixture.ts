import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { strictCoordinatorHarness } from '../runtime/rpc/strict-coordinator-test-fixture'
import { COORD, WORKER } from '../runtime/rpc/strict-coordinator-test-fixture'
import { idOf, resultOf } from '../runtime/rpc/orchestration-session-caller-test-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../runtime/rpc/methods/orchestration'
import { readRestartRef } from './orcad-planned-source'
import { z } from 'zod'
import { orchestrationRequest } from '../runtime/rpc/orchestration-session-caller-test-fixture'

export async function nextPlannedSourceFixture(
  root: string,
  previous: Awaited<ReturnType<typeof plannedSourceFixture>>,
  restored: ReturnType<typeof restoredPlannedRuntime>,
  source: ReturnType<typeof strictCoordinatorHarness>,
  transition: Record<string, unknown>
) {
  const old = previous.proposal
  const transitionRef = writeRestartFixture(join(root, 'transition-1.json'), transition)
  const plan = writeRestartFixture(join(root, 'plan-2.json'), {
    ...z.record(z.string(), z.unknown()).parse(readRestartRef(old.plan)),
    schema_version: 3, recovery: { transition: transitionRef }
  })
  const checkpoint = writeRestartFixture(join(old.scope.projection.continuation_state_root, 'checkpoint-2.json'), {
    checkpoint: { next_action: { id: 'pending-action-2' } }
  })
  writeRestartFixture(join(old.scope.projection.continuation_state_root, 'head.json'), checkpoint)
  const messageId = idOf(resultOf(await restored.dispatcher.dispatch(orchestrationRequest('orchestration.send', {
    from: WORKER, to: `run:${previous.runId}`, subject: 'continue', body: 'Second pending action',
    payload: JSON.stringify({ kind: 'coordinator_tui_continue_v1', config: old.scope.projection.evidence_refs[2],
      checkpoint, action_id: 'pending-action-2', recovery_plan: plan })
  }, { evidence: source.evidence(WORKER), requestId: 'second-continuation' }))).message)
  const outbox = { actions: { pending: { delivery: { message_id: messageId }, claimed_at: null,
    result: null, request_id: 'second-continuation', checkpoint } } }
  writeRestartFixture(join(old.scope.projection.continuation_state_root, 'outbox.json'), outbox)
  return { runId: previous.runId, messageId, proposal: { ...old, plan,
    pending_message: { id: messageId }, snapshot: { action_key: 'pending', outbox, files: [checkpoint] },
    scope: { projection: { ...old.scope.projection, evidence_refs: [plan, ...old.scope.projection.evidence_refs.slice(1)] } }
  } }
}

export function writeRestartFixture(path: string, value: unknown) {
  const bytes = `${JSON.stringify(value)}\n`
  writeFileSync(path, bytes, { mode: 0o600 })
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export async function plannedSourceFixture(
  root: string,
  harness: ReturnType<typeof strictCoordinatorHarness>
) {
  const runId = await harness.create()
  const monitor = join(root, 'monitor')
  const continuation = join(root, 'continuation')
  for (const path of [monitor, continuation]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const cli = writeRestartFixture(join(root, 'cli'), {})
  const contract = writeRestartFixture(join(root, 'contract.json'), { cli })
  const head = join(continuation, 'head.json')
  const cref = writeRestartFixture(join(root, 'continuation.json'), {
    state_root: continuation,
    contract,
    checkpoint_head: head
  })
  const binding = {
    runtime: harness.runtime.getRuntimeId(),
    run: runId,
    terminal: COORD,
    generation: harness.db.getRun(runId)!.consumer_generation
  }
  const config = writeRestartFixture(join(root, 'config.json'), {
    binding,
    state_root: monitor,
    continuation: cref,
    watch_file: null,
    adapters: [],
    artifact_roots: []
  })
  const plan = writeRestartFixture(join(root, 'plan.json'), {
    config,
    sources: [],
    sender: { terminal: WORKER }
  })
  const checkpoint = writeRestartFixture(join(continuation, 'checkpoint.json'), {
    checkpoint: { next_action: { id: 'pending-action' } }
  })
  writeRestartFixture(head, checkpoint)
  const messageId = idOf(
    resultOf(
      await harness.call(
        'orchestration.send',
        {
          from: WORKER,
          to: `run:${runId}`,
          body: 'Continue the pending action',
          payload: JSON.stringify({
            kind: 'coordinator_tui_continue_v1',
            config: cref,
            checkpoint,
            action_id: 'pending-action'
          })
        },
        WORKER,
        'original-continuation'
      )
    ).message
  )
  const outbox = {
    actions: {
      pending: {
        delivery: { message_id: messageId },
        claimed_at: null,
        result: null,
        request_id: 'original-continuation',
        checkpoint
      }
    }
  }
  writeRestartFixture(join(continuation, 'outbox.json'), outbox)
  const proposal = {
    schema_version: 1,
    kind: 'cross-runtime-source-observation',
    plan,
    binding,
    snapshot: { action_key: 'pending', outbox, files: [checkpoint] },
    pending_message: { id: messageId },
    scope: {
      projection: {
        monitor_state_root: monitor,
        continuation_state_root: continuation,
        evidence_refs: [plan, config, cref, contract],
        code_refs: [cli]
      }
    }
  }
  return { runId, proposal, messageId }
}

/** Exercise restored caller verification, not the fresh-launch shortcut. */
export function restoredPlannedRuntime(
  source: ReturnType<typeof strictCoordinatorHarness>,
  runtimeId: string
) {
  const attest = vi.fn(
    ({ paneKey, launchTokenHash }: { paneKey: string; launchTokenHash: string }) => {
      const authority = [...source.authorities.values()].find((item) => item.paneKey === paneKey)
      return authority?.launchTokenHash === launchTokenHash
        ? { paneKey, source: 'hydrated_commitment' as const }
        : null
    }
  )
  const runtime = new OrcaRuntimeService(null, undefined, {
    runtimeId,
    attestAgentHookCompatibilityAuthority: attest
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test seeds the same receipt map as native PTY restoration.
  const internals = runtime as unknown as {
    restoredOrchestrationAuthorityByPtyId: Map<string, unknown>
  }
  for (const authority of source.authorities.values()) {
    internals.restoredOrchestrationAuthorityByPtyId.set(authority.ptyId, { ...authority })
  }
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => {
    const authority = source.authorities.get(handle)
    return authority ? { ...authority, launchTokenHash: null } : null
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
    (handle) => source.authorities.get(handle)?.paneKey ?? null
  )
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
    (handle) => source.authorities.get(handle)?.paneKey ?? null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
    (handle) => source.authorities.get(handle)?.processIncarnation ?? null
  )
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  return { runtime, dispatcher, attest }
}
