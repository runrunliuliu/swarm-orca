import { z } from 'zod'
import type { OrchestrationDb } from './db'
import type { OrchestrationCompatibilityCallerAuthority } from '../runtime-terminal-contracts'
import { OrchestrationError } from './orchestration-error'
import { isEquivalentPaneKey } from './db/pane-key-match'

export const strictTerminalAuthoritySchema = z.object({
  terminalHandle: z.string().min(1),
  paneKey: z.string().min(1),
  processIncarnation: z.string().min(1),
  launchTokenHash: z.string().min(1),
  hostScope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), hostId: z.string() }),
    z.object({ kind: z.literal('ssh'), targetId: z.string() }),
    z.object({ kind: z.literal('wsl'), hostId: z.string(), distro: z.string() })
  ])
})
const PolicyRow = z.object({ run_id: z.string(), authority: z.string() })

export function strictRunRetirement(db: Pick<OrchestrationDb, 'db'>, runId: string): unknown {
  const row = db.db
    .prepare('SELECT receipt FROM strict_run_retirements WHERE run_id = ?')
    .get(runId)
  return row ? JSON.parse(z.object({ receipt: z.string() }).parse(row).receipt) : undefined
}

export function strictCoordinatorRefusal(runId: string, reason: string): never {
  throw new OrchestrationError(
    'strict_coordinator_required',
    `Run ${runId}: ${reason}. Drive its Coordinator; do not take over or retry as another role.`,
    { runId }
  )
}

export function strictCoordinatorPolicy(db: Pick<OrchestrationDb, 'db'>, runId: string) {
  const row = db.db
    .prepare('SELECT run_id, authority FROM strict_run_coordinators WHERE run_id = ?')
    .get(runId)
  if (!row) {
    return undefined
  }
  const parsed = PolicyRow.parse(row)
  return { runId: parsed.run_id, authority: strictTerminalAuthoritySchema.parse(JSON.parse(parsed.authority)) }
}

export function hasStrictCoordinatorRuns(db: OrchestrationDb): boolean {
  return db.hasStrictCoordinatorRunsCache
}

export function pinStrictCoordinator(
  db: OrchestrationDb,
  runId: string,
  authority: OrchestrationCompatibilityCallerAuthority
): void {
  db.db
    .prepare('INSERT INTO strict_run_coordinators (run_id, authority) VALUES (?, ?)')
    .run(runId, JSON.stringify(strictTerminalAuthoritySchema.parse(authority)))
}

// Keep settled attempts protected too: a report is not proof that its agent process exited.
export function strictWorkerRunIds(
  db: OrchestrationDb,
  target: { handle?: string | null; paneKey?: string | null; sessionId?: string | null },
  includeRetired = false
): string[] {
  if (!target.handle && !target.paneKey && !target.sessionId) {
    return []
  }
  const rows = z
    .array(
      z.object({
        run_id: z.string(),
        assignee_handle: z.string().nullable(),
        assignee_pane_key: z.string().nullable(),
        assignee_orca_session_id: z.string().nullable()
      })
    )
    .parse(
      db.db
        .prepare(`
    SELECT d.run_id, d.assignee_handle, d.assignee_pane_key, d.assignee_orca_session_id
    FROM dispatch_contexts d JOIN strict_run_coordinators s ON s.run_id = d.run_id
    WHERE d.assignee_handle = ? OR d.assignee_orca_session_id = ?
      OR (? IS NOT NULL AND d.assignee_pane_key IS NOT NULL)
    UNION
    SELECT d.run_id, r.terminal_handle, r.pane_key, NULL
    FROM worker_terminal_resources r
    JOIN dispatch_contexts d ON d.id = r.owner_dispatch_id
    JOIN strict_run_coordinators s ON s.run_id = d.run_id
    WHERE r.terminal_handle = ? OR (? IS NOT NULL AND r.pane_key IS NOT NULL)
  `)
        .all(
          target.handle ?? null,
          target.sessionId ?? null,
          target.paneKey ?? null,
          target.handle ?? null,
          target.paneKey ?? null
        )
    )
  return [
    ...new Set(
      rows
        .filter((row) => includeRetired || strictRunRetirement(db, row.run_id) === undefined)
        .filter(
          (row) =>
            (target.handle && row.assignee_handle === target.handle) ||
            (target.sessionId && row.assignee_orca_session_id === target.sessionId) ||
            (target.paneKey &&
              row.assignee_pane_key &&
              isEquivalentPaneKey(target.paneKey, row.assignee_pane_key))
        )
        .map((row) => row.run_id)
    )
  ]
}
