// The single tool-error collection point (issue-sedimentation.md v2.5 §7.3, M4-1).
//
// WRITE POINT: the structured-session event sink's item append, i.e. the live attach path's
// `appendItem`/`tryAppendItem` (structured-agent-session-event-sink.ts). Chosen over the journal's own
// append because:
//   * the journal append is the *convergence* point for live writes, legacy import
//     (`replaceEpochItems`) AND restore/backfill (`journal-store-restore.ts`) — counting there would
//     count history twice on every reattach;
//   * the sink is created per session for a live attach only, receives the whole item body (tool name,
//     state, bounded output head) and the journal's own turn attribution, and nothing else calls it;
//   * an item append is an upsert by stable item id, so a re-sent item is the same tool result. This
//     module dedupes by `(sessionId, itemKey, ordinal)` as well, which is what makes a repeated attach
//     or a coalesced re-append unable to double count even within one process.
//
// What is NOT here: no transcript reads, no provider stderr, no timers. The window is in-memory (see
// incident-tool-error-window.ts for the restart cost).

import type Database from '../sqlite/sync-database'
import type { AgentJournalItemBody, AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import type { IncidentStore } from './incident-store'
import { persistIncidentRecord, incidentRuntimeStore } from './incident-writer'
import { mainProcessUserDataPath } from './incidents-paths'
import { writeMeta } from './incident-store-capacity'
import {
  TOOL_ERROR_KEY_REJECTED_META,
  TOOL_ERROR_WRITE_FAILURES_META,
  buildToolErrorRecord,
  publishToolErrorWindows
} from './incident-tool-error-report'
import { toolErrorObservations } from './incident-tool-error-blocks'
import { classifyToolError, type ToolErrorCode } from './incident-tool-error-classifier'
import {
  createToolErrorWindowTracker,
  type ToolErrorWindowTracker
} from './incident-tool-error-window'

/** §7.3 grayscale switch: anything but `on` keeps the writer off. */
export const TOOL_ERROR_WRITE_ENV = 'INCIDENT_TOOL_ERROR_WRITE'
const DEDUPE_CAPACITY = 2048

export type ToolErrorWriteEnabled = (env?: NodeJS.ProcessEnv) => boolean

export function toolErrorWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TOOL_ERROR_WRITE_ENV] === 'on'
}

const tracker: ToolErrorWindowTracker = createToolErrorWindowTracker()
/** `sessionId\0itemKey\0ordinal` of already-counted observations; bounded FIFO. */
const counted = new Set<string>()

function markCounted(key: string): boolean {
  if (counted.has(key)) {
    return false
  }
  counted.add(key)
  if (counted.size > DEDUPE_CAPACITY) {
    const oldest = counted.values().next().value
    if (oldest !== undefined) {
      counted.delete(oldest)
    }
  }
  return true
}

export type ToolErrorObservationInput = {
  sessionId: string
  /** Stable journal item id; the dedupe unit. */
  itemKey: string
  turnScope: AgentJournalTurnScope
  body: AgentJournalItemBody
  now?: number
  /** Test seam: the process store, or a real one from a test fixture. */
  runtime?: { store: IncidentStore; db: Database.Database } | null
  /** Test seam: skip the shadow write when a test only cares about rows. */
  shadow?: boolean
}

export type ToolErrorObserverOptions = {
  runtime?: { store: IncidentStore; db: Database.Database } | null
  shadow?: boolean
}

export type ToolErrorObservationResult = {
  /** Failed tool calls in the item (0 for a healthy item). */
  observations: number
  /** Windows that would write if the switch were on, this observation included. */
  candidates: { code: ToolErrorCode; count: number; windowStart: number; toolName: string }[]
  written: number
}

/**
 * Count one journaled item's failed tool calls.
 *
 * Never throws: this runs inside the journal write path, and a diagnostics counter must not be able to
 * fail a session's append.
 */
export function observeToolErrorItem(input: ToolErrorObservationInput): ToolErrorObservationResult {
  const result: ToolErrorObservationResult = { observations: 0, candidates: [], written: 0 }
  const injectedRuntime = input.runtime === undefined ? undefined : input.runtime
  const shadow = input.shadow ?? true
  try {
    const now = input.now ?? Date.now()
    const { turn, observations } = toolErrorObservations(input.body, input.turnScope)
    if (observations.length === 0) {
      return result
    }
    const runtime = injectedRuntime === undefined ? incidentRuntimeStore() : injectedRuntime
    const writeEnabled = toolErrorWriteEnabled()
    for (const observation of observations) {
      if (!markCounted(`${input.sessionId}\u0000${input.itemKey}\u0000${observation.ordinal}`)) {
        continue
      }
      const classification = classifyToolError({
        output: observation.output,
        isError: true,
        errorKind: observation.errorKind,
        exitCode: observation.exitCode
      })
      const code = classification.code
      result.observations += 1
      const window = tracker.record({
        sessionId: input.sessionId,
        toolName: observation.toolName,
        code,
        turn,
        at: now,
        highSeverity: classification.highSeverity
      })
      if (!window.wouldWriteIfEnabled) {
        continue
      }
      result.candidates.push({
        code,
        count: window.count,
        windowStart: window.windowStart,
        toolName: observation.toolName
      })
      if (!writeEnabled || window.alreadyWritten || runtime === null) {
        continue
      }
      const record = buildToolErrorRecord({
        sessionId: input.sessionId,
        turn: window.lastTurn,
        toolName: observation.toolName,
        code,
        count: window.count,
        windowStart: window.windowStart,
        highSeverity: window.highSeverity,
        classification,
        now
      })
      if (!record.ok) {
        bumpMeta(runtime.db, TOOL_ERROR_KEY_REJECTED_META)
        continue
      }
      const { result: insert } = persistIncidentRecord(runtime.store, record.record, {
        userDataPath: shadow ? mainProcessUserDataPath() : null
      })
      if (insert.outcome === 'inserted' || insert.outcome === 'duplicate') {
        tracker.markWritten(
          { sessionId: input.sessionId, turn: window.lastTurn, toolName: observation.toolName, code },
          window.windowStart
        )
        if (insert.outcome === 'inserted') {
          result.written += 1
        }
      } else {
        bumpMeta(runtime.db, TOOL_ERROR_WRITE_FAILURES_META)
      }
    }
    if (runtime !== null) {
      publishToolErrorWindows(runtime.db, tracker, writeEnabled)
    }
    return result
  } catch {
    // Counter only; a throwing hook would break the journal append it rides on.
    try {
      const runtime = injectedRuntime === undefined ? incidentRuntimeStore() : injectedRuntime
      if (runtime !== null && runtime !== undefined) {
        bumpMeta(runtime.db, TOOL_ERROR_WRITE_FAILURES_META)
      }
    } catch {
      // Nothing left to do.
    }
    return result
  }
}

/** Bump one meta counter; the record path must not depend on the full coverage machinery. */
function bumpMeta(db: Database.Database, key: string): void {
  const row = db.prepare('SELECT value FROM incident_store_meta WHERE key = ?').get(key)
  const current = Number(row?.value ?? 0)
  writeMeta(db, key, String((Number.isFinite(current) ? current : 0) + 1))
}

export function __resetToolErrorObserverForTests(): void {
  tracker.reset()
  counted.clear()
}

export {
  TOOL_ERROR_KEY_REJECTED_META,
  TOOL_ERROR_WINDOWS_META,
  TOOL_ERROR_WRITE_FAILURES_META,
  buildToolErrorRecord,
  readToolErrorWindows,
  type ToolErrorWindowsSnapshot
} from './incident-tool-error-report'
