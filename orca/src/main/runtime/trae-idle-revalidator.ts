import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { readTraeIdleLogEvidence } from './trae-idle-log-evidence'
import type { TraeIdleRevalidationRequest } from '../agent-hooks/trae-idle-revalidation'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { launchTokenHashForStatusRow } from './orchestration/worker-provider-session'

export type TraeIdleProbeTarget = {
  row: AgentStatusIpcPayload
  restoredLaunchAttested: boolean
  incarnation: string
  outputSequence: number
  input: { sequence: number; lastInputAt: number | null; observedSince: number; complete: boolean }
  controller: object
  confirmForeground(): Promise<string | null>
}

function targetKey(target: TraeIdleProbeTarget): string {
  const { row } = target
  return JSON.stringify([
    row.paneKey,
    row.launchToken,
    row.launchTokenHash,
    row.connectionId,
    row.providerSession,
    row.receivedAt,
    row.evidenceObservedAt,
    row.observation,
    row.state,
    target.restoredLaunchAttested,
    target.incarnation,
    target.outputSequence,
    target.input
  ])
}

function hasLaunchIdentity(row: AgentStatusIpcPayload): boolean {
  return launchTokenHashForStatusRow(row) !== null
}

function hasRestoredLaunchHashOnlyIdentity(row: AgentStatusIpcPayload): boolean {
  return !row.launchToken?.trim() && launchTokenHashForStatusRow(row) !== null
}

export function requiresRestoredLaunchTraeRevalidation(
  row: AgentStatusIpcPayload
): boolean {
  return (
    row.agentType === 'trae' &&
    hasRestoredLaunchHashOnlyIdentity(row) &&
    !row.traeIdleRevalidation
  )
}

/** In-flight work only; all accepted status observations live in the hook server. */
export class TraeIdleRevalidator {
  private readonly probes = new Map<string, Promise<boolean>>()

  constructor(
    private readonly deps: {
      target(ptyId: string): TraeIdleProbeTarget | null
      publish(ptyId: string, request: TraeIdleRevalidationRequest): boolean
    }
  ) {}

  probe(ptyId: string, force = false, ownedInputSequence?: number): Promise<boolean> {
    const pending = this.probes.get(ptyId)
    if (pending) {
      // A send must not borrow a background probe's earlier evidence.
      return force ? Promise.resolve(false) : pending
    }
    const target = this.deps.target(ptyId)
    const row = target?.row
    const observed = row?.evidenceObservedAt ?? row?.receivedAt ?? Number.NaN
    const hookObservedAt = row?.traeIdleRevalidation?.hookObservedAt ?? observed
    const restoredLaunchNeedsProof = row ? requiresRestoredLaunchTraeRevalidation(row) : false
    const restoredLaunchProof = Boolean(
      target?.restoredLaunchAttested && row && hasRestoredLaunchHashOnlyIdentity(row)
    )
    if (
      !target ||
      !row ||
      row.agentType !== 'trae' ||
      row.connectionId !== null ||
      !hasLaunchIdentity(row) ||
      !target.incarnation ||
      row.state !== 'done' ||
      !row.providerSession?.transcriptPath ||
      row.providerSession.key !== 'session_id' ||
      row.restoredUnconfirmed ||
      row.providerSessionOnly ||
      !Number.isFinite(observed) ||
      observed > Date.now() ||
      (restoredLaunchNeedsProof && !restoredLaunchProof) ||
      (!force &&
        !(restoredLaunchNeedsProof && restoredLaunchProof) &&
        Date.now() - observed <= AGENT_STATUS_STALE_AFTER_MS) ||
      (!target.input.complete && !restoredLaunchProof) ||
      (target.input.observedSince > hookObservedAt && !restoredLaunchProof) ||
      (target.input.lastInputAt !== null &&
        target.input.lastInputAt >= hookObservedAt &&
        !(
          force &&
          ownedInputSequence === target.input.sequence &&
          row.traeIdleRevalidation?.inputSequence === ownedInputSequence - 1
        ))
    ) {
      return Promise.resolve(false)
    }
    const started = Date.now()
    const controller = target.controller
    const key = targetKey(target)
    const stillCurrent = () => {
      const current = this.deps.target(ptyId)
      return (
        Date.now() >= started &&
        Date.now() - started < 2_000 &&
        !!current &&
        current.controller === controller &&
        targetKey(current) === key
      )
    }
    const logInput = {
      path: row.providerSession.transcriptPath,
      sessionId: row.providerSession.id,
      hookObservedAt
    }
    const work = (async () => {
      const before = await readTraeIdleLogEvidence(logInput)
      if (!before || !stillCurrent()) {
        return false
      }
      const foreground = await target.confirmForeground()
      if (recognizeAgentProcess(foreground)?.agent !== 'trae' || !stillCurrent()) {
        return false
      }
      const after = await readTraeIdleLogEvidence(logInput)
      if (before !== after || !stillCurrent()) {
        return false
      }
      // A staged pointer is a draft, not a new idle observation for other readers.
      if (force) {
        return true
      }
      return this.deps.publish(ptyId, {
        expected: row,
        proof: {
          hookObservedAt,
          inputSequence: target.input.sequence,
          processIncarnation: target.incarnation
        }
      })
    })()
    // A timed-out but hung provider keeps its slot; retries cannot multiply outstanding IO.
    const bounded = withTimeout(work, 2_000, false)
    this.probes.set(ptyId, bounded)
    void work
      .catch(() => {})
      .finally(() => {
        if (this.probes.get(ptyId) === bounded) {
          this.probes.delete(ptyId)
        }
      })
    return bounded
  }
}
