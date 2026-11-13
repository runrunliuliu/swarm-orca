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
import type { ToolErrorClassification, ToolErrorCode } from './incident-tool-error-classifier'
import type { ToolErrorWindowSnapshot, ToolErrorWindowTracker } from './incident-tool-error-window'

export const TOOL_ERROR_WINDOWS_META = 'tool_error_windows'
export const TOOL_ERROR_KEY_REJECTED_META = 'tool_error_key_rejected'
export const TOOL_ERROR_WRITE_FAILURES_META = 'tool_error_write_failures'
const MAX_PUBLISHED_WINDOWS = 50

export type ToolErrorWindowsSnapshot = {
  updatedAt: number | null
  writeEnabled: boolean
  /** Windows in this payload (capped at MAX_PUBLISHED_WINDOWS). */
  published: number
  /** Windows the collector held when it published; greater than `published` means truncation. */
  total: number
  /** Windows dropped by the LRU bound since start; counts were lost if this is non-zero. */
  evicted: number
  windows: ToolErrorWindowSnapshot[]
}

export function readToolErrorWindows(db: Database.Database): ToolErrorWindowsSnapshot {
  const row = db.prepare('SELECT value FROM incident_store_meta WHERE key = ?').get(TOOL_ERROR_WINDOWS_META)
  if (!row || typeof row.value !== 'string') {
    return { updatedAt: null, writeEnabled: false, published: 0, total: 0, evicted: 0, windows: [] }
  }
  try {
    const parsed: unknown = JSON.parse(String(row.value))
    if (typeof parsed !== 'object' || parsed === null) {
      return { updatedAt: null, writeEnabled: false, published: 0, total: 0, evicted: 0, windows: [] }
    }
    const record = parsed as Record<string, unknown>
    const windows = Array.isArray(record.windows) ? (record.windows as ToolErrorWindowSnapshot[]) : []
    return {
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : null,
      writeEnabled: record.writeEnabled === true,
      published: typeof record.published === 'number' ? record.published : windows.length,
      total: typeof record.total === 'number' ? record.total : windows.length,
      evicted: typeof record.evicted === 'number' ? record.evicted : 0,
      windows
    }
  } catch {
    return { updatedAt: null, writeEnabled: false, published: 0, total: 0, evicted: 0, windows: [] }
  }
}

/** Publish the window snapshot for the read-only CLI (a different process from this one). */
export function publishToolErrorWindows(
  db: Database.Database,
  tracker: ToolErrorWindowTracker,
  writeEnabled: boolean
): void {
  const total = tracker.size()
  const windows = tracker.snapshot().slice(0, MAX_PUBLISHED_WINDOWS)
  writeMeta(
    db,
    TOOL_ERROR_WINDOWS_META,
    JSON.stringify({
      updatedAt: Date.now(),
      writeEnabled,
      published: windows.length,
      total,
      evicted: tracker.evicted(),
      windows
    })
  )
}

type BuildRecordInput = {
  sessionId: string
  turn: string
  toolName: string
  code: ToolErrorCode
  count: number
  windowStart: number
  highSeverity: boolean
  classification: ToolErrorClassification
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
          `归类依据=${input.classification.confidence}${
            input.classification.textHint
              ? `（文本只提供低可信聚类提示 ${input.classification.textHint}，未参与 severity 与 code）`
              : ''
          }；原始错误文本未存。`,
          '高危（单次直通）只来自 provider 的结构化拒绝 kind；结构化 exitCode≠0 优先归为 non_zero_exit。',
          '窗口计数是进程内滑动窗口，重启会重置；跨重启的同一突发事件可能延后一个窗口才达成阈值。'
        ],
        code: input.code,
        ...(input.classification.textHint ? { repro: `text_hint:${input.classification.textHint}` } : {})
      },
      summary:
        `${input.code} ×${input.count}${input.highSeverity ? ' (structured denial)' : ''} from ` +
        `tool ${input.toolName} in turn ${input.turn} within 10m`,
      createdAt: input.now
    }
  }
}

