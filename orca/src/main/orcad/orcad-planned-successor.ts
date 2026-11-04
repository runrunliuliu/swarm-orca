import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { z } from 'zod'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { strictCoordinatorPolicy } from '../runtime/orchestration/strict-coordinator-policy'
import { assertPlannedTerminal } from './orcad-planned-restart-records'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from '../daemon/daemon-spawner'
import { replaceDaemonProvider } from '../daemon/daemon-provider-state'
import type { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { PlannedSuccessorRequest } from '../../shared/rpc-contract/planned-restart-params'
import { plannedRestartTargetMaintenance } from './orcad-planned-target'
export { PlannedSuccessorRequest }

/** No spawner, degraded provider, replacement PTY or caller-supplied runtime ID. */
export async function admitPlannedSuccessor(
  root: string,
  lineage: ReturnType<typeof openOrcadRuntimeLineage>,
  request: z.infer<typeof PlannedSuccessorRequest>
) {
  const preparation = lineage.plannedRestart.preparation()
  const pin = preparation.daemon
  if (!pin) {
    throw new Error('planned_restart_daemon_pin_required')
  }
  const runtimeDir = join(root, 'daemon')
  const adapter = new DaemonPtyAdapter({
    socketPath: getDaemonSocketPath(runtimeDir),
    tokenPath: getDaemonTokenPath(runtimeDir),
    pidPath: getDaemonPidPath(runtimeDir),
    runtimeDir
  })
  let db: OrchestrationDb | undefined
  try {
    await adapter.establishLifecycleLease()
    if ((await adapter.plannedRestart('Inspect', pin)).state !== 'frozen') {
      throw new Error('planned_restart_daemon_not_frozen')
    }
    const runtimeId = randomUUID()
    db = new OrchestrationDb(join(root, 'orchestration.db'), (connection) => {
      lineage.plannedRestart.consume(connection, {
        ...PlannedSuccessorRequest.parse(request),
        targetRuntimeId: runtimeId,
        frozenDaemonRetry: true
      })
    })
    const database = db
    replaceDaemonProvider(adapter)
    return {
      runtimeId,
      db: database,
      maintenance: plannedRestartTargetMaintenance(lineage),
      async activate(runtime: OrcaRuntimeService) {
        if (runtime.getRuntimeId() !== runtimeId) {
          throw new Error('planned_restart_runtime_mismatch')
        }
        const coordinator = strictCoordinatorPolicy(database, preparation.runId)?.authority
        if (!coordinator) {
          throw new Error('planned_restart_coordinator_missing')
        }
        for (const expected of [coordinator, preparation.preparer, preparation.sender]) {
          assertPlannedTerminal(runtime, expected)
        }
      },
      async commit() {
        // A failed release can retry only while the surviving daemon still proves frozen.
        lineage.plannedRestart.commit()
        await adapter.plannedRestart('Release', pin)
        lineage.plannedRestart.activate(database.db)
      },
      async close() {
        try {
          await adapter.disconnectOnly()
        } finally {
          database.close()
        }
      }
    }
  } catch (error) {
    db?.close()
    await adapter.disconnectOnly()
    throw error
  }
}

export type PlannedSuccessor = Awaited<ReturnType<typeof admitPlannedSuccessor>>
