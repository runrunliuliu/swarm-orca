import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { writeRefused, type WriteSettlement } from '../../shared/pty-write-settlement'
import type { TraeIdleRevalidationRequest } from '../agent-hooks/trae-idle-revalidation'
import { writeOrchestrationPointerWithSettlement } from './orchestration/mailbox-pointer-pty-write'
import { selectFreshAgentRowForMobileTab } from './runtime-hook-agent-row-selection'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import {
  requiresRestoredLaunchTraeRevalidation,
  TraeIdleRevalidator,
  type TraeIdleProbeTarget
} from './trae-idle-revalidator'

export type TraeMailboxTarget = {
  row: AgentStatusIpcPayload
  restoredLaunchAttested: boolean
  handle: string
  incarnation: string | null
  input: TraeIdleProbeTarget['input'] | null
  outputSequence: number
  controller: RuntimePtyController | null
  localProbeAllowed: boolean
}

function acceptedTraeIdleRevalidation(
  accepted: AgentStatusIpcPayload | undefined,
  request: TraeIdleRevalidationRequest
): boolean {
  const proof = accepted?.traeIdleRevalidation
  if (
    !proof ||
    proof.hookObservedAt !== request.proof.hookObservedAt ||
    proof.inputSequence !== request.proof.inputSequence ||
    proof.processIncarnation !== request.proof.processIncarnation
  ) {
    return false
  }
  const expectedRevision = request.expected.observation?.revision
  const acceptedRevision = accepted?.observation?.revision
  if (expectedRevision !== undefined || acceptedRevision !== undefined) {
    return acceptedRevision !== expectedRevision
  }
  return true
}

/** Delivery fences only; status is always read from the canonical hook store. */
export class TraeMailboxDelivery {
  private readonly pointerInputs = new Map<
    string,
    { sequence: number; incarnation: string; session: string }
  >()
  readonly revalidator: TraeIdleRevalidator

  constructor(
    private readonly deps: {
      target(ptyId: string): TraeMailboxTarget | null
      publish(ptyId: string, request: TraeIdleRevalidationRequest): void
      redrive?(ptyId: string): void
    }
  ) {
    this.revalidator = new TraeIdleRevalidator({
      target: (ptyId) => {
        const target = deps.target(ptyId)
        const confirm = target?.controller?.confirmForegroundProcess
        if (
          !target?.localProbeAllowed ||
          !target.input ||
          !target.incarnation ||
          !confirm ||
          !target.controller
        ) {
          return null
        }
        return {
          ...target,
          input: target.input,
          incarnation: target.incarnation,
          controller: target.controller,
          confirmForeground: () => confirm.call(target.controller, ptyId)
        }
      },
      publish: (ptyId, request) => {
        deps.publish(ptyId, request)
        const accepted = deps.target(ptyId)?.row
        const ok = acceptedTraeIdleRevalidation(accepted, request)
        if (ok) {
          deps.redrive?.(ptyId)
        }
        return ok
      }
    })
  }

  clear(ptyId: string): void {
    this.pointerInputs.delete(ptyId)
  }

  status(ptyId: string | null | undefined, allowStagedInput = false) {
    const target = ptyId ? this.deps.target(ptyId) : null
    if (!target || !ptyId) {
      return null
    }
    const { row: raw, input, incarnation } = target
    if (!raw.traeIdleRevalidation) {
      this.clear(ptyId)
    }
    if (requiresRestoredLaunchTraeRevalidation(raw)) {
      return null
    }
    if (raw.traeIdleRevalidation) {
      const staged = this.pointerInputs.get(ptyId)
      if (
        !input ||
        incarnation !== raw.traeIdleRevalidation.processIncarnation ||
        (input.sequence !== raw.traeIdleRevalidation.inputSequence &&
          !(
            allowStagedInput &&
            staged?.sequence === input.sequence &&
            staged.incarnation === incarnation &&
            staged.session === `${raw.providerSession?.key}:${raw.providerSession?.id}`
          ))
      ) {
        return null
      }
    }
    const row = selectFreshAgentRowForMobileTab({
      paneKey: raw.paneKey,
      terminalHandle: target.handle,
      hookRows: [raw]
    })
    const observed = row?.evidenceObservedAt ?? row?.updatedAt
    if (
      !row ||
      row.payload.agentType !== 'trae' ||
      observed === undefined ||
      !Number.isFinite(observed) ||
      observed > Date.now() ||
      Date.now() - observed > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return null
    }
    return {
      state: row.payload.state,
      updatedAt: observed,
      providerSession: `${raw.providerSession?.key}:${raw.providerSession?.id}`,
      revalidated: !!raw.traeIdleRevalidation
    }
  }

  async write(ptyId: string, data: string, canWrite: () => boolean): Promise<WriteSettlement> {
    try {
      return await this.settle(ptyId, data, canWrite)
    } finally {
      if (data === '\r') {
        this.clear(ptyId)
      }
    }
  }

  private async settle(
    ptyId: string,
    data: string,
    canWrite: () => boolean
  ): Promise<WriteSettlement> {
    const target = this.deps.target(ptyId)
    const expected = this.status(ptyId, data === '\r')
    if (!target?.controller?.confirmForegroundProcess || !expected || !target.incarnation) {
      return writeRefused('provider_cannot_settle')
    }
    if (!canWrite()) {
      return writeRefused('provider_refused_write')
    }
    const { controller, handle, incarnation, input: inputBefore, outputSequence } = target
    let foregroundConfirmed = false
    try {
      if (expected.revalidated) {
        const ownedInput = data === '\r' ? this.pointerInputs.get(ptyId)?.sequence : undefined
        if (!(await this.revalidator.probe(ptyId, true, ownedInput))) {
          return writeRefused('provider_refused_write')
        }
        foregroundConfirmed = true
      } else {
        const foreground = await withTimeout(
          controller.confirmForegroundProcess!(ptyId),
          2_000,
          null
        )
        foregroundConfirmed = recognizeAgentProcess(foreground)?.agent === 'trae'
      }
    } catch {
      return writeRefused('provider_unavailable')
    }
    const currentTarget = this.deps.target(ptyId)
    const current = this.status(ptyId, data === '\r')
    if (
      !currentTarget ||
      controller !== currentTarget.controller ||
      !foregroundConfirmed ||
      !current ||
      current.providerSession !== expected.providerSession ||
      currentTarget.handle !== handle ||
      currentTarget.incarnation !== incarnation ||
      (expected.revalidated && currentTarget.outputSequence !== outputSequence) ||
      (inputBefore && currentTarget.input?.sequence !== inputBefore.sequence) ||
      (current.state !== 'done' && !(data === '\r' && current.state === 'working')) ||
      !canWrite()
    ) {
      return writeRefused('provider_refused_write')
    }
    const settlement = await writeOrchestrationPointerWithSettlement({ ptyId, data, controller })
    if (expected.revalidated && data !== '\r' && settlement.outcome === 'accepted') {
      const input = this.deps.target(ptyId)?.input
      if (input && inputBefore && input.sequence === inputBefore.sequence + 1) {
        this.pointerInputs.set(ptyId, {
          sequence: input.sequence,
          incarnation,
          session: expected.providerSession
        })
      }
    }
    return settlement
  }
}
