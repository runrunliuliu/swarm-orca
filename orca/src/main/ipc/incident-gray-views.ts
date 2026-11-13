// The two grayscale read-only views over IPC (§7.2, §7.3; M7-B).
//
// These are projections, not new judgement: `readStallSamples` / `readToolErrorWindows` are the exact
// functions `orca incident stalls` and `orca incident tool-errors` already call, and the sampling
// policy, thresholds and the write switch stay where they are (the host process). The panel must be
// able to say "observed, not recorded" without being able to make anything recorded.
//
// Why a separate module instead of growing `incidents.ts`: the list/detail/counts surface is the
// triage read model, and these two are diagnostics with their own vocabulary (`wouldWriteIfEnabled`,
// `ageBasis`, provider coverage). Keeping them apart makes the "this cannot write" property readable.

import type { IncidentIpcResult } from './incidents'
import { incidentRuntimeStore } from '../incidents/incident-writer'
import { readStallSamples } from '../incidents/incident-stall-samples'
import {
  readToolErrorWindows,
  toolErrorWriteEnabled
} from '../incidents/incident-tool-error-observer'
import {
  TOOL_ERROR_COVERED_PROVIDERS,
  TOOL_ERROR_UNCOVERED_PROVIDERS
} from '../incidents/incident-tool-error-coverage'
import type {
  IncidentStallsViewDto,
  IncidentToolErrorsViewDto
} from '../../shared/incident-gray-types'

function unavailable<T>(): IncidentIpcResult<T> {
  return {
    ok: false,
    code: 'incident_store_unavailable',
    error:
      'The incident store is not available on this host yet. It is created by the running Orca runtime.'
  }
}

/**
 * `orca incident stalls` over IPC: the last sample, never a write.
 *
 * The store is opened with the same runtime resolver the writers use, so the panel and the CLI read
 * one connection (including its capacity latch) instead of a second opener that could disagree.
 */
export function readIncidentStallsView(): IncidentIpcResult<IncidentStallsViewDto> {
  const runtime = incidentRuntimeStore()
  if (runtime === null) {
    return unavailable()
  }
  return {
    ok: true,
    value: {
      rows: readStallSamples(runtime.db),
      coverage: runtime.store.coverage()
    }
  }
}

/**
 * `orca incident tool-errors` over IPC: the published window snapshot plus the switch's live value.
 *
 * `writeEnabled` is the host process's environment when this process is the host, and the published
 * value otherwise — the same rule the CLI applies. It reports the switch; it never sets it.
 */
export function readIncidentToolErrorsView(): IncidentIpcResult<IncidentToolErrorsViewDto> {
  const runtime = incidentRuntimeStore()
  if (runtime === null) {
    return unavailable()
  }
  const snapshot = readToolErrorWindows(runtime.db)
  return {
    ok: true,
    value: {
      updatedAt: snapshot.updatedAt,
      writeEnabled: snapshot.writeEnabled || toolErrorWriteEnabled(),
      published: snapshot.published,
      total: snapshot.total,
      evicted: snapshot.evicted,
      windows: snapshot.windows.map((window) => ({
        sessionId: window.sessionId,
        turn: window.turn,
        toolName: window.toolName,
        code: window.code,
        count: window.count,
        windowStart: window.windowStart,
        lastAt: window.lastAt,
        highSeverity: window.highSeverity,
        wouldWriteIfEnabled: window.wouldWriteIfEnabled,
        written: window.written
      })),
      coveredProviders: [...TOOL_ERROR_COVERED_PROVIDERS],
      uncoveredProviders: [...TOOL_ERROR_UNCOVERED_PROVIDERS]
    }
  }
}
