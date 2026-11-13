// The tool-error window snapshot and the record it can write (issue-sedimentation.md v2.5 §7.3).
//
// Split from the collector so the collector stays a small "count one observation" function, and so the
// row builder sits next to the publish/read pair that the CLI uses. The snapshot is JSON in meta
// because the CLI is a different process from the one holding the in-memory windows.

import type Database from '../sqlite/sync-database'
import type { IncidentRecord } from './incident-types'
import { buildIncidentKey, incidentFingerprint } from './incident-key'
import { mintIncidentId } from './incident-writer'
import { resolveLocalHostId } from './incidents-paths'
import { writeMeta } from './incident-store-capacity'
import type { ToolErrorCode } from './incident-tool-error-classifier'
import type { ToolErrorWindowSnapshot, ToolErrorWindowTracker } from './incident-tool-error-window'

export const TOOL_ERROR_WINDOWS_META = 'tool_error_windows'
export const TOOL_ERROR_KEY_REJECTED_META = 'tool_error_key_rejected'
export const TOOL_ERROR_WRITE_FAILURES_META = 'tool_error_write_failures'
const MAX_PUBLISHED_WINDOWS = 50

export type ToolErrorWindowsSnapshot = {
  updatedAt: number | null
  writeEnabled: boolean
  windows: ToolErrorWindowSnapshot[]
}

export function readToolErrorWindows(db: Database.Database): ToolErrorWindowsSnapshot {
  const row = db.prepare('SELECT value FROM incident_store_meta WHERE key = ?').get(TOOL_ERROR_WINDOWS_META)
  if (!row || typeof row.value !== 'string') {
    return { updatedAt: null, writeEnabled: false, windows: [] }
  }
  try {
    const parsed: unknown = JSON.parse(String(row.value))
    if (typeof parsed !== 'object' || parsed === null) {
      return { updatedAt: null, writeEnabled: false, windows: [] }
    }
    const record = parsed as Record<string, unknown>
    return {
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : null,
      writeEnabled: record.writeEnabled === true,
      windows: Array.isArray(record.windows) ? (record.windows as ToolErrorWindowSnapshot[]) : []
    }
  } catch {
    return { updatedAt: null, writeEnabled: false, windows: [] }
  }
}

/** Publish the window snapshot for the read-only CLI (a different process from this one). */
export function publishToolErrorWindows(
  db: Database.Database,
  tracker: ToolErrorWindowTracker,
  writeEnabled: boolean
): void {
  const windows = tracker.snapshot().slice(0, MAX_PUBLISHED_WINDOWS)
  writeMeta(db, TOOL_ERROR_WINDOWS_META, JSON.stringify({ updatedAt: Date.now(), writeEnabled, windows }))
}

type BuildRecordInput = {
  sessionId: string
  turn: string
  toolName: string
  code: ToolErrorCode
  count: number
  windowStart: number
  highSeverity: boolean
  now: number
}

/** The row, or a refused key (M4-1's "must go through buildIncidentKey"). */
export function buildToolErrorRecord(
  input: BuildRecordInput
): { ok: true; record: IncidentRecord } | { ok: false; reason: string } {
  const key = buildIncidentKey({
    kind: 'tool_error',
    sessionId: input.sessionId,
    turn: input.turn,
    code: input.code,
    windowStart: input.windowStart
  })
  if (!key.ok) {
    return { ok: false, reason: `tool_error_key_${key.reason}` }
  }
  return {
    ok: true,
    record: {
      id: mintIncidentId(),
      sourceKind: key.sourceKind,
      sourceId: key.sourceId,
      facet: key.facet,
      hostId: resolveLocalHostId(),
      worktreeId: null,
      runId: null,
      taskId: null,
      dispatchId: null,
      agentSessionId: input.sessionId,
      ptyIncarnationId: null,
      class: 'tool_error',
      status: 'untriaged',
      exitCause: null,
      fingerprint: incidentFingerprint({
        class: 'tool_error',
        sourceKind: key.sourceKind,
        facet: key.facet,
        signature: [`code:${input.code}`, `tool:${input.toolName}`]
      }),
      evidence: {
        pointers: [],
        unknownBoundaries: [
          '错误码由分类器归一（原始错误文本未存）；分类只用于聚簇，不参与处置决策。',
          '窗口计数是进程内滑动窗口，重启会重置；跨重启的同一突发事件可能延后一个窗口才达成阈值。'
        ],
        code: input.code
      },
      summary:
        `${input.code} ×${input.count}${input.highSeverity ? ' (high severity)' : ''} from ` +
        `tool ${input.toolName} within 10m`,
      createdAt: input.now
    }
  }
}

