// The two grayscale read-only views over IPC (§7.2, §7.3; M7-B).
//
// These are projections, not new judgement: `readPaneClocks` / `readToolFailures` are the exact
// functions `orca incident pane-clocks` and `orca incident tool-errors` already call. The pane-clock
// view carries facts only (M8-2 removed the threshold and the verdict); the tool-error view still
// reports its collector switch until M8-3. Neither view can make anything recorded.
//
// Why a separate module instead of growing `incidents.ts`: the list/detail/counts surface is the
// triage read model, and these two are diagnostics with their own vocabulary (`wouldWriteIfEnabled`,
// `ageBasis`, provider coverage). Keeping them apart makes the "this cannot write" property readable.

import type { IncidentIpcResult } from './incidents'
import { openIncidentReadStore } from '../incidents/incident-read-service'
import { readPaneClocks } from '../incidents/incident-pane-clocks'
import {
  TOOL_ERROR_COVERED_PROVIDERS,
  TOOL_ERROR_UNCOVERED_PROVIDERS
} from '../incidents/incident-tool-error-coverage'
import { readToolFailures } from '../incidents/incident-tool-failures'
import type {
  IncidentPaneClocksViewDto,
  IncidentToolFailuresViewDto
} from '../../shared/incident-gray-types'

function unavailable<T>(error?: string): IncidentIpcResult<T> {
  return {
    ok: false,
    code: 'incident_store_unavailable',
    error:
      error ??
      'The incident store is not available on this host yet. It is created by the running Orca runtime.'
  }
}

/**
 * A host that has never written an incident is a *stated* empty answer for these two fact tables: no
 * rows were ever recorded, which is not the same as "the store is broken".
 */
function notCreated<T>(): IncidentIpcResult<T> {
  return {
    ok: false,
    code: 'incident_store_not_created',
    error: 'This host has never recorded an incident, so there are no facts to show.'
  }
}

/**
 * `orca incident pane-clocks` over IPC: the stored pane facts, never a write and never a verdict.
 *
 * The store is opened with the same runtime resolver the writers use, so the panel and the CLI read
 * one connection (including its capacity latch) instead of a second opener that could disagree.
 */
export function readIncidentPaneClocksView(): IncidentIpcResult<IncidentPaneClocksViewDto> {
  // Why the read-only opener: a diagnostics tab must not be the reason `<userData>/incidents/` appears.
  const handle = openIncidentReadStore()
  if (handle.availability === 'unavailable') {
    return unavailable(handle.error)
  }
  if (handle.availability === 'store-not-created') {
    return notCreated<IncidentPaneClocksViewDto>()
  }
  try {
    return {
      ok: true,
      value: {
        rows: readPaneClocks(handle.db, Date.now()),
        coverage: handle.store.coverage()
      }
    }
  } finally {
    handle.close()
  }
}

/**
 * `orca incident tool-failures` over IPC: the raw recorded facts plus the provider coverage.
 *
 * No switch, no window, no `written` flag: M8-3 removed the writer and the normalisation, so every row
 * here is a fact and the panel cannot imply that a row is (or is about to become) an incident.
 */
export function readIncidentToolFailuresView(): IncidentIpcResult<IncidentToolFailuresViewDto> {
  const handle = openIncidentReadStore()
  if (handle.availability === 'unavailable') {
    return unavailable(handle.error)
  }
  if (handle.availability === 'store-not-created') {
    return notCreated<IncidentToolFailuresViewDto>()
  }
  try {
    const snapshot = readToolFailures(handle.db, {
      now: Date.now(),
      windowMs: 7 * 24 * 60 * 60 * 1000,
      limit: 200
    })
    return {
      ok: true,
      value: {
        since: snapshot.since,
        rows: snapshot.rows,
        total: snapshot.total,
        truncated: snapshot.truncated,
        dropped: snapshot.dropped,
        coveredProviders: [...TOOL_ERROR_COVERED_PROVIDERS],
        uncoveredProviders: [...TOOL_ERROR_UNCOVERED_PROVIDERS]
      }
    }
  } finally {
    handle.close()
  }
}
