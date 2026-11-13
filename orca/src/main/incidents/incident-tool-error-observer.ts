// The structured-journal tool-failure recorder (M8-3).
//
// One write point, one fact per failed tool call. The old observer classified the failure into a
// normalized code, counted a 5-in-10-minutes window, and wrote an incident when the window crossed the
// threshold; M8-3 deleted all three. This module now stores what the provider already said:
// `errorKind` and `exitCode`, unmodified, with no text and no incident.
//
// It still has to be the *only* write point (§7.3): restore / legacy import / `replaceEpochItems`
// deliberately do not come through the journal notification, so replaying history cannot inflate the
// store. The database's `(session, item_key, ordinal)` primary key absorbs a repeated notification.

import type Database from '../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { incidentRuntimeStore } from './incident-writer'
import { recordToolFailure, type ToolFailureRecordResult } from './incident-tool-failures'
import { toolErrorObservations } from './incident-tool-error-blocks'

export type ToolErrorObservationInput = {
  sessionId: string
  /** Stable journal item id; part of the dedupe key. */
  itemKey: string
  turnScope: AgentJournalTurnScope
  body: AgentJournalItemBody
  now?: number
  /** Test seam: the process store, or a real one from a test fixture. */
  runtime?: { db: Database.Database } | null
}

export type ToolErrorObservationResult = {
  /** Failed tool calls found in the item (0 for a healthy item). */
  observations: number
  recorded: number
  duplicates: number
  dropped: number
}

/**
 * Record one journaled item's failed tool calls.
 *
 * Never throws: this runs inside the journal write path, and a diagnostics fact must not be able to
 * fail a session's append.
 */
export function observeToolErrorItem(input: ToolErrorObservationInput): ToolErrorObservationResult {
  const result: ToolErrorObservationResult = { observations: 0, recorded: 0, duplicates: 0, dropped: 0 }
  try {
    const now = input.now ?? Date.now()
    const { turn, observations } = toolErrorObservations(input.body, input.turnScope)
    if (observations.length === 0) {
      return result
    }
    const runtime = input.runtime === undefined ? incidentRuntimeStore() : input.runtime
    if (runtime === null) {
      // No store on this host yet: nothing to record, and nothing to count as a failure either.
      result.observations = observations.length
      return result
    }
    for (const observation of observations) {
      result.observations += 1
      const outcome: ToolFailureRecordResult = recordToolFailure(runtime.db, {
        sessionId: input.sessionId,
        itemKey: input.itemKey,
        ordinal: observation.ordinal,
        turn,
        toolName: observation.toolName,
        errorKind: observation.errorKind,
        exitCode: observation.exitCode,
        observedAt: now
      })
      if (outcome === 'inserted') {
        result.recorded += 1
      } else if (outcome === 'duplicate') {
        result.duplicates += 1
      } else {
        result.dropped += 1
      }
    }
    return result
  } catch {
    return result
  }
}
