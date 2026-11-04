import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { RpcContext } from '../runtime/rpc/core'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'

export const RestartFileRef = z
  .object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
export function restartRefBytes(input: unknown): Buffer {
  const ref = RestartFileRef.parse(input)
  const bytes = readFileSync(ref.path)
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
    throw new Error('planned_restart_file_pin_changed')
  }
  return bytes
}
export function readRestartRef(input: unknown): unknown {
  return JSON.parse(restartRefBytes(input).toString('utf8'))
}
const Binding = z
  .object({ runtime: z.string(), run: z.string(), terminal: z.string(), generation: z.number() })
  .passthrough()
const Plan = z
  .object({
    config: RestartFileRef,
    sources: z.array(RestartFileRef),
    sender: z.object({ terminal: z.string() }).passthrough()
  })
  .passthrough()
const Config = z
  .object({
    binding: Binding,
    state_root: z.string(),
    continuation: RestartFileRef,
    watch_file: z.null(),
    adapters: z.array(z.unknown()).length(0),
    artifact_roots: z.array(z.unknown()).length(0)
  })
  .passthrough()
const Continuation = z
  .object({ state_root: z.string(), contract: RestartFileRef, checkpoint_head: z.string() })
  .passthrough()
export const PlannedSource = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('cross-runtime-source-observation'),
    plan: RestartFileRef,
    binding: Binding,
    snapshot: z
      .object({
        action_key: z.string(),
        outbox: z.object({ actions: z.record(z.string(), z.unknown()) }).passthrough(),
        files: z.array(RestartFileRef)
      })
      .passthrough(),
    pending_message: z.object({ id: z.string() }).passthrough(),
    scope: z
      .object({
        projection: z
          .object({
            monitor_state_root: z.string(),
            continuation_state_root: z.string(),
            evidence_refs: z.array(RestartFileRef),
            code_refs: z.array(RestartFileRef)
          })
          .passthrough()
      })
      .passthrough()
  })
  .passthrough()

export function plannedSourceScope(input: unknown) {
  const proposal = PlannedSource.parse(input)
  const plan = Plan.parse(readRestartRef(proposal.plan))
  const config = Config.parse(readRestartRef(plan.config))
  const continuation = Continuation.parse(readRestartRef(config.continuation))
  const contract = z
    .object({ cli: RestartFileRef })
    .passthrough()
    .parse(readRestartRef(continuation.contract))
  const {
    scope: { projection }
  } = proposal
  if (
    config.state_root !== projection.monitor_state_root ||
    continuation.state_root !== projection.continuation_state_root ||
    hashCanonical(config.binding) !== hashCanonical(proposal.binding) ||
    hashCanonical(projection.code_refs) !== hashCanonical([contract.cli, ...plan.sources])
  ) {
    throw new Error('planned_restart_deployment_scope_changed')
  }
  for (const ref of [proposal.plan, plan.config, config.continuation, continuation.contract]) {
    if (!projection.evidence_refs.some((entry) => hashCanonical(entry) === hashCanonical(ref))) {
      throw new Error('planned_restart_deployment_pin_missing')
    }
  }
  return {
    monitorStateRoot: config.state_root,
    continuationStateRoot: continuation.state_root,
    files: projection.evidence_refs.map((ref) => ref.path)
  }
}

/** The Python snapshot is held under the existing locks; native DB identity is checked again after freeze. */
export function checkPlannedSource(
  ctx: RpcContext,
  input: unknown,
  runId: string,
  sender: string,
  verifiedSourceRuntime?: string
) {
  const proposal = PlannedSource.parse(input)
  plannedSourceScope(proposal)
  const plan = Plan.parse(readRestartRef(proposal.plan))
  const config = Config.parse(readRestartRef(plan.config))
  const continuation = Continuation.parse(readRestartRef(config.continuation))
  if (plan.sender.terminal !== sender) {
    throw new Error('planned_restart_sender_changed')
  }
  const db = ctx.runtime.getOrchestrationDb()
  const run = db.getRun(runId)
  if (
    !run ||
    (verifiedSourceRuntime ?? proposal.binding.runtime) !== ctx.runtime.getRuntimeId() ||
    proposal.binding.run !== runId ||
    proposal.binding.terminal !== run.coordinator_handle ||
    proposal.binding.generation !== run.consumer_generation
  ) {
    throw new Error('planned_restart_source_binding_changed')
  }
  const scope = proposal.scope.projection
  for (const root of [scope.monitor_state_root, scope.continuation_state_root]) {
    if (existsSync(join(root, 'STOP'))) {
      throw new Error('planned_restart_manual_stop')
    }
  }
  for (const ref of [...scope.evidence_refs, ...proposal.snapshot.files]) {
    restartRefBytes(ref)
  }
  for (const ref of scope.code_refs) {
    if (createHash('sha256').update(readFileSync(ref.path)).digest('hex') !== ref.sha256) {
      throw new Error('planned_restart_code_changed')
    }
  }
  const entry = z
    .object({
      delivery: z.object({ message_id: z.string() }),
      claimed_at: z.null(),
      result: z.null(),
      request_id: z.string(),
      checkpoint: RestartFileRef
    })
    .passthrough()
    .parse(proposal.snapshot.outbox.actions[proposal.snapshot.action_key])
  const pending = db.db
    .prepare(
      "SELECT id FROM messages WHERE run_id = ? AND to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'"
    )
    .all(runId, `run:${runId}`)
  if (
    pending.length !== 1 ||
    pending[0]?.id !== entry.delivery.message_id ||
    pending[0]?.id !== proposal.pending_message.id ||
    db.getMessageById(entry.delivery.message_id)?.from_handle !== sender
  ) {
    throw new Error('planned_restart_pending_changed')
  }
  const receipts = db.db
    .prepare(
      "SELECT receipt FROM mutation_receipts WHERE request_id = ? AND state = 'completed' AND method = 'orchestration.send'"
    )
    .all(entry.request_id)
  const message = db.getMessageById(entry.delivery.message_id)
  const matches = receipts.filter(
    (row) =>
      typeof row.receipt === 'string' &&
      z
        .object({ message: z.object({ id: z.string() }).passthrough() })
        .passthrough()
        .safeParse(JSON.parse(row.receipt)).data?.message.id === message?.id
  )
  if (matches.length !== 1) {
    throw new Error('planned_restart_request_unconfirmed')
  }
  const checkpoint = z
    .object({
      checkpoint: z
        .object({ next_action: z.object({ id: z.string() }).passthrough() })
        .passthrough()
    })
    .parse(readRestartRef(entry.checkpoint))
  if (
    !message?.payload ||
    hashCanonical(JSON.parse(message.payload)) !==
      hashCanonical({
        kind: 'coordinator_tui_continue_v1',
        config: config.continuation,
        checkpoint: entry.checkpoint,
        action_id: checkpoint.checkpoint.next_action.id,
        ...(plan.schema_version === 3 ? { recovery_plan: proposal.plan } : {})
      }) ||
    hashCanonical(JSON.parse(readFileSync(continuation.checkpoint_head, 'utf8'))) !==
      hashCanonical(entry.checkpoint)
  ) {
    throw new Error('planned_restart_pending_payload_changed')
  }
  if (
    db.db
      .prepare(
        'SELECT 1 FROM deliveries, json_each(deliveries.message_ids) WHERE json_each.value = ? LIMIT 1'
      )
      .get(message.id)
  ) {
    throw new Error('planned_restart_pending_already_consumed')
  }
  if (
    db.db
      .prepare("SELECT 1 FROM dispatch_contexts WHERE status IN ('pending', 'dispatched') LIMIT 1")
      .get()
  ) {
    throw new Error('planned_restart_requires_no_active_workers')
  }
  const current = JSON.parse(
    readFileSync(join(scope.continuation_state_root, 'outbox.json'), 'utf8')
  )
  if (hashCanonical(current) !== hashCanonical(proposal.snapshot.outbox)) {
    throw new Error('planned_restart_outbox_changed')
  }
}
