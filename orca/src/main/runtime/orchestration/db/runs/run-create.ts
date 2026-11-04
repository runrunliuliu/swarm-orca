import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import { mailboxAddressOf } from '../../orchestration-caller-identity'
import {
  pinStrictCoordinator,
  strictCoordinatorPolicy,
  strictCoordinatorRefusal
} from '../../strict-coordinator-policy'
import type { OrchestrationCompatibilityCallerAuthority } from '../../../runtime-terminal-contracts'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle: string | null
    coordinatorPaneKey: string | null
    /** The coordinator's bare Orca session id when it is a structured session; see orca-session-address. */
    coordinatorOrcaSessionId?: OrcaSessionId | null
    strictCoordinator?: OrchestrationCompatibilityCallerAuthority
  }
): RunRow {
  const coordinator = {
    terminalHandle: params.coordinatorHandle,
    paneKey: params.coordinatorPaneKey,
    orcaSessionId: params.coordinatorOrcaSessionId ?? null
  }
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const current = this.getCurrentRunForCoordinator(coordinator)
    if (current && strictCoordinatorPolicy(this, current.id)) {
      strictCoordinatorRefusal(
        current.id,
        'strict-v1 does not support rebinding; keep using the pinned Run'
      )
    }
    this.unbindOtherRunsForCoordinator(coordinator)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key, coordinator_orca_session_id,
           coordinator_orca_session_id_generation, consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, 1, 1, 0)`
      )
      .run(
        id,
        params.objective,
        coordinator.terminalHandle,
        coordinator.paneKey,
        coordinator.orcaSessionId
      )
    const address = mailboxAddressOf(coordinator)
    if (address !== null) {
      this.rememberRunCoordinatorHandle(id, address)
    }
    if (params.strictCoordinator) {
      pinStrictCoordinator(this, id, params.strictCoordinator)
    }
    this.db.exec('COMMIT')
    if (params.strictCoordinator) {
      this.hasStrictCoordinatorRunsCache = true
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(id) as RunRow
}

export type RunCreateMethods = {
  createRun: typeof createRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun
  })
}
