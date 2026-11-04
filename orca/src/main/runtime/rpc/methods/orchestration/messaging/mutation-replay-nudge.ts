import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import {
  assertStrictCoordinator,
  assertStrictReplayRecipient
} from '../../../strict-coordinator-authority'
import {
  attachMutationReplayNudge,
  type MutationReplayNudge
} from '../../../orchestration-mutation-receipt'

/** Persists the receipt (with its replay nudge) before waking recipients, for mutations whose effect is already durable. */
export function recordReceiptBeforeNudge<T>(
  recordMutationReceipt: ((receipt: unknown) => void) | undefined,
  receipt: T,
  nudge: () => void,
  replayNudge: MutationReplayNudge | undefined = messageReplayNudge(receipt)
): T {
  recordMutationReceipt?.(replayNudge ? attachMutationReplayNudge(receipt, replayNudge) : receipt)
  nudge()
  return receipt
}

/** Same, but hands the nudge back so the caller can fire it after its enclosing transaction commits. */
export function recordReceiptForPostCommitNudge<T>(
  recordMutationReceipt: ((receipt: unknown) => void) | undefined,
  receipt: T,
  nudge: () => void,
  replayNudge: MutationReplayNudge | undefined = messageReplayNudge(receipt)
): { receipt: T; nudge: () => void } {
  recordMutationReceipt?.(replayNudge ? attachMutationReplayNudge(receipt, replayNudge) : receipt)
  return { receipt, nudge }
}

export function messageReplayNudge(receipt: unknown): MutationReplayNudge | undefined {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return undefined
  }
  const source = receipt as { message?: unknown; messages?: unknown }
  const rows = source.message
    ? [source.message]
    : Array.isArray(source.messages)
      ? source.messages
      : []
  const targets = rows.flatMap((row) => {
    if (!row || typeof row !== 'object') {
      return []
    }
    const candidate: Record<string, unknown> = { ...row }
    return typeof candidate.to_handle === 'string' && typeof candidate.type === 'string'
      ? [
          {
            to: candidate.to_handle,
            type: candidate.type,
            ...(typeof candidate.run_id === 'string' ? { runId: candidate.run_id } : {}),
            ...(typeof candidate.id === 'string' ? { messageIds: [candidate.id] } : {})
          }
        ]
      : []
  })
  return targets.length === rows.length && targets.length > 0
    ? { kind: 'messages', targets }
    : undefined
}

type ReplayDeliveryRuntime = OrcaRuntimeService & {
  deliverPendingMessagesForHandle?: (handle: string, reservedTypes?: ReadonlySet<string>) => void
}

function redriveMailboxDelivery(runtime: OrcaRuntimeService, handle: string): void {
  const deliveryRuntime = runtime as ReplayDeliveryRuntime
  if (typeof deliveryRuntime.deliverPendingMessagesForHandle !== 'function') {
    return
  }
  queueMicrotask(() => {
    try {
      deliveryRuntime.deliverPendingMessagesForHandle?.(handle)
    } catch (error) {
      console.warn('[orchestration] replay mailbox delivery redrive failed', {
        handle,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

export function replayMutationNudge(
  runtime: OrcaRuntimeService,
  replayNudge: MutationReplayNudge,
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
): void {
  const ctx = { runtime, orchestrationCompatibilityEvidence }
  if (replayNudge.kind === 'federation') {
    if (replayNudge.runId) {
      assertStrictCoordinator(ctx, replayNudge.runId)
    }
    runtime.ensureOrchestrationFederationRelay(replayNudge.runId)
    return
  }
  for (const target of replayNudge.targets) {
    assertStrictReplayRecipient(ctx, target)
  }
  const db = runtime.getOrchestrationDb()
  for (const target of replayNudge.targets) {
    if (target.messageIds?.length) {
      db.redriveDeliveredUnreadMessagesForHandle(target.to, target.messageIds)
    }
    runtime.notifyMessageArrived(target.to, target.type)
    redriveMailboxDelivery(runtime, target.to)
  }
}
