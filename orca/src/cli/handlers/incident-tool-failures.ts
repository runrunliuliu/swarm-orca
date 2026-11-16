// `orca incident tool-failures` (M8-3): the raw failed-tool-call facts, read-only.
//
// There is no normalisation, no window and no verdict here. The command exists so an operator (and the
// triage skill) can see what the host actually recorded, with the provider coverage that says which
// agents this collector cannot see.

import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import { DEFAULT_EXPORT_WINDOW_MS, parseExportWindow } from '../../main/incidents/incident-export'
import { clampToolFailureLimit, readToolFailures } from '../../main/incidents/incident-tool-failures'
import {
  TOOL_ERROR_COVERED_PROVIDERS,
  TOOL_ERROR_UNCOVERED_PROVIDERS
} from '../../main/incidents/incident-tool-error-coverage'
import { formatIncidentToolFailures } from '../incident-tool-failure-format'
import {
  intFlag,
  printIncidentJson,
  refuseNonLocalIncidentSelector,
  stringFlag
} from './incident-shared'

export const toolFailuresIncident = async (ctx: HandlerContext): Promise<void> => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident tool-failures')
  const sinceRaw = stringFlag(ctx, 'since')
  const windowMs = sinceRaw === null ? undefined : parseExportWindow(sinceRaw)
  if (sinceRaw !== null && windowMs === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --since "${sinceRaw}". Use a duration such as 24h, 7d or 90m.`
    )
  }
  const limit = intFlag(ctx, 'limit', { min: 1 })
  const now = Date.now()
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    const snapshot =
      opened.db === null
        ? { since: now - (windowMs ?? DEFAULT_EXPORT_WINDOW_MS), rows: [], total: 0, truncated: false, dropped: 0 }
        : readToolFailures(opened.db, {
            now,
            windowMs: windowMs ?? DEFAULT_EXPORT_WINDOW_MS,
            limit: clampToolFailureLimit(limit ?? 200)
          })
    if (ctx.json) {
      printIncidentJson({
        ...snapshot,
        coveredProviders: [...TOOL_ERROR_COVERED_PROVIDERS],
        uncoveredProviders: [...TOOL_ERROR_UNCOVERED_PROVIDERS]
      })
      return
    }
    console.log(
      formatIncidentToolFailures(snapshot, {
        covered: [...TOOL_ERROR_COVERED_PROVIDERS],
        uncovered: [...TOOL_ERROR_UNCOVERED_PROVIDERS]
      })
    )
  } finally {
    opened.close()
  }
}
