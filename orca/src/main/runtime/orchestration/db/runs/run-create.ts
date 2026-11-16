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
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationCompatibilityCallerAuthority } from '../../../runtime-terminal-contracts'
import { hashCanonical } from '../../../rpc/orchestration-mutation-receipt'
import {
  bindStartGrantToRun,
  objectiveHashOf,
  readStartGrant,
  readStartGrantBinding,
  readStartGrantRevocation
} from '../../start-grant-policy'

// ── Runs ──

type CoordinatorBinding = {
  objective: string
  coordinatorHandle: string | null
  coordinatorPaneKey: string | null
  /** The coordinator's bare Orca session id when it is a structured session; see orca-session-address. */
  coordinatorOrcaSessionId?: OrcaSessionId | null
  strictCoordinator?: OrchestrationCompatibilityCallerAuthority
}

export type StartGrantAdmission = {
  grantId: string
  /** The coordinator's live authority; also recorded as the binding's author. */
  authority: OrchestrationCompatibilityCallerAuthority
}

/**
 * The grant checks, in this order, before the caller's first write.
 *
 * They run inside the same `BEGIN IMMEDIATE` as the insert so that "may this grant still cover a Run"
 * and "bind it" cannot interleave, and every refusal happens before the `runs` insert, which is why a
 * refused create leaves no Run row to reconcile. Returns the already-bound Run when this is an exact
 * replay, so the caller can report `effectsApplied: false` instead of writing a second Run.
 */
function admitStartGrant(
  db: OrchestrationDb,
  params: CoordinatorBinding,
  admission: StartGrantAdmission
): { replayed: true; run: RunRow } | undefined {
  const grant = readStartGrant(db, admission.grantId)
  if (!grant) {
    throw new OrchestrationError(
      'start_grant_unknown',
      `Start grant ${admission.grantId} does not exist; create the Run under a grant that was minted for it.`,
      { grantId: admission.grantId }
    )
  }
  const revocation = readStartGrantRevocation(db, grant.grantId)
  if (revocation) {
    throw new OrchestrationError(
      'start_grant_revoked',
      `Start grant ${grant.grantId} was revoked at ${revocation.revokedAt}: ${revocation.reason}`,
      { grantId: grant.grantId, revokedAt: revocation.revokedAt }
    )
  }
  if (Date.now() > Date.parse(grant.deadline)) {
    throw new OrchestrationError(
      'start_grant_expired',
      `Start grant ${grant.grantId} expired at ${grant.deadline}; a grant cannot be renewed by the agent using it.`,
      { grantId: grant.grantId, deadline: grant.deadline }
    )
  }
  if (objectiveHashOf(params.objective) !== grant.objectiveHash) {
    throw new OrchestrationError(
      'start_grant_objective_mismatch',
      `Start grant ${grant.grantId} approves a different objective; a Run may not start under another approval.`,
      { grantId: grant.grantId }
    )
  }
  const bound = readStartGrantBinding(db, { grantId: grant.grantId })
  if (!bound) {
    return undefined
  }
  const sameCaller =
    hashCanonical(bound.boundAuthority) === hashCanonical(admission.authority)
  const existing = db.getRun(bound.runId)
  if (sameCaller && existing) {
    return { replayed: true, run: existing }
  }
  throw new OrchestrationError(
    'start_grant_already_bound',
    `Start grant ${grant.grantId} already covers Run ${bound.runId}; one approval creates one Run.`,
    { grantId: grant.grantId, runId: bound.runId }
  )
}

function insertRun(
  db: OrchestrationDb,
  params: CoordinatorBinding,
  admission?: StartGrantAdmission
): { run: RunRow; replayed: boolean } {
  const coordinator = {
    terminalHandle: params.coordinatorHandle,
    paneKey: params.coordinatorPaneKey,
    orcaSessionId: params.coordinatorOrcaSessionId ?? null
  }
  const id = generateId('run')
  db.db.exec('BEGIN IMMEDIATE')
  let replayed: { run: RunRow } | undefined
  try {
    // The grant is read before the rebinding fence: an exact replay of the same create must return
    // the Run this grant already covers, and the fence would otherwise refuse it as a rebind (the
    // Coordinator is bound to that very Run).
    const existing = admission ? admitStartGrant(db, params, admission) : undefined
    if (existing) {
      replayed = existing
      db.db.exec('COMMIT')
    } else {
      const current = db.getCurrentRunForCoordinator(coordinator)
      if (current && strictCoordinatorPolicy(db, current.id)) {
        strictCoordinatorRefusal(
          current.id,
          'strict-v1 does not support rebinding; keep using the pinned Run'
        )
      }
      db.unbindOtherRunsForCoordinator(coordinator)
      db.db
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
        db.rememberRunCoordinatorHandle(id, address)
      }
      if (params.strictCoordinator) {
        pinStrictCoordinator(db, id, params.strictCoordinator)
      }
      if (admission) {
        bindStartGrantToRun(db, {
          grantId: admission.grantId,
          runId: id,
          boundAuthority: admission.authority
        })
      }
      db.db.exec('COMMIT')
      if (params.strictCoordinator) {
        db.hasStrictCoordinatorRunsCache = true
      }
    }
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
  if (replayed) {
    return { run: replayed.run, replayed: true }
  }
  return { run: db.getRun(id) as RunRow, replayed: false }
}

export function createRun(this: OrchestrationDb, params: CoordinatorBinding): RunRow {
  return insertRun(this, params).run
}

/**
 * Create the one Run a start grant covers.
 *
 * Separate from `createRun` rather than an optional flag on it: the caller needs the truthful
 * `replayed` answer (a repeat of the same intent must report `effectsApplied: false`), and the
 * checks must be impossible to skip by calling the other entry point.
 *
 * There is deliberately no self-mint check here. Whether a Run may be created by the same terminal
 * that minted its grant is §8 decision 5, which is open; enabling it silently would be this design
 * claiming a guarantee it does not enforce.
 */
export function createGrantedRun(
  this: OrchestrationDb,
  params: CoordinatorBinding & { startGrant: StartGrantAdmission }
): { run: RunRow; replayed: boolean } {
  return insertRun(this, params, params.startGrant)
}

export type RunCreateMethods = {
  createRun: typeof createRun
  createGrantedRun: typeof createGrantedRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun,
    createGrantedRun
  })
}
