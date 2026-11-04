import { z } from 'zod'
import type { OrchestrationDb } from './db'
import { strictCoordinatorRefusal } from './strict-coordinator-policy'

export function strictRetirementInventory(db: OrchestrationDb, runId: string) {
  const tasks = db.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY id').all(runId)
  const dispatches = db.db
    .prepare('SELECT * FROM dispatch_contexts WHERE run_id = ? ORDER BY id')
    .all(runId)
  const workers = db.db
    .prepare(`SELECT w.* FROM worker_dispatches w JOIN dispatch_contexts d
    ON d.id = w.dispatch_id WHERE d.run_id = ? ORDER BY w.dispatch_id`)
    .all(runId)
  const resources = db.db
    .prepare(`SELECT r.* FROM worker_terminal_resources r
    JOIN dispatch_contexts d ON d.id = r.owner_dispatch_id WHERE d.run_id = ? ORDER BY r.id`)
    .all(runId)
  const gates = db.db
    .prepare('SELECT * FROM decision_gates WHERE run_id = ? ORDER BY id')
    .all(runId)
  return { tasks, dispatches, workers, resources, gates }
}

export function assertStrictRetirementSettled(
  inventory: ReturnType<typeof strictRetirementInventory>,
  runId: string
) {
  const statuses = z.array(z.object({ status: z.string() }))
  if (
    statuses.parse(inventory.tasks).some((row) => !['completed', 'failed'].includes(row.status)) ||
    statuses
      .parse(inventory.dispatches)
      .some((row) => !['completed', 'failed', 'circuit_broken'].includes(row.status)) ||
    statuses.parse(inventory.gates).some((row) => row.status === 'pending') ||
    z
      .array(z.object({ state: z.string() }))
      .parse(inventory.workers)
      .some((row) => !['failed', 'succeeded', 'stopped', 'abandoned'].includes(row.state)) ||
    z
      .array(z.object({ release_state: z.string() }))
      .parse(inventory.resources)
      .some((row) => ['requested', 'releasing', 'unknown'].includes(row.release_state))
  ) {
    strictCoordinatorRefusal(
      runId,
      'settle Tasks, Dispatches, gates and uncertain resource operations before retirement'
    )
  }
}

export function strictRetirementProcesses(
  inventory: ReturnType<typeof strictRetirementInventory>,
  runId: string
) {
  const parsed = z
    .array(z.object({ process_incarnation: z.string().min(1), host_scope: z.string().min(1) }))
    .safeParse([...inventory.dispatches, ...inventory.resources])
  if (!parsed.success) {
    strictCoordinatorRefusal(
      runId,
      'historical Worker process identity or execution-host scope is missing'
    )
  }
  return [...new Map(parsed.data.map((process) => [JSON.stringify(process), process])).values()]
}
