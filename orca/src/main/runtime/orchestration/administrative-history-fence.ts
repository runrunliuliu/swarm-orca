import { z } from 'zod'
import type { OrchestrationDb } from './db'
import { isEquivalentPaneKey } from './db/pane-key-match'
import { OrchestrationError } from './orchestration-error'

export function assertNoAdministrativeHistoryFence(
  db: OrchestrationDb,
  addresses: readonly string[],
  panes: readonly string[]
): void {
  if (!db.hasAdministrativeHistoryFences) {
    return
  }
  const addressQuery = db.db.prepare(
    "SELECT receipt_id FROM administrative_history_fences WHERE kind = 'address' AND identity = ?"
  )
  const found = addresses.some((address) => addressQuery.get(address))
  const paneRows = panes.length
    ? z
        .array(z.object({ identity: z.string() }))
        .parse(
          db.db
            .prepare("SELECT identity FROM administrative_history_fences WHERE kind = 'pane'")
            .all()
        )
    : []
  if (
    found ||
    paneRows.some((row) => panes.some((pane) => isEquivalentPaneKey(row.identity, pane)))
  ) {
    throw new OrchestrationError(
      'administrative_history_quarantined',
      'This identity belongs to administratively archived history. It cannot be resumed or reused; inspect the maintenance receipt.'
    )
  }
}
