// Shapes for the incident store (issue-sedimentation.md v2.2 §6).
//
// An incident is a *derived*, non-authoritative record: it never feeds a protocol decision, a
// settlement, or an authorization check. Its one job is to make a failure readable and triageable
// after the fact. The facts live in their own places (`TerminalExitCause`, dispatch rows, journals);
// this row points at them.
//
// Immutability is an engine constraint, not a convention: `incidents` rows are INSERT-only and
// status changes are append-only `incident_decisions` rows (§6.2). `status` on the incident row is
// therefore the *entry* status, and the effective status is projected from the decision log.

import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { IncidentShadowReplayCoverage } from './incident-shadow-coverage'

/** §6.2 `class`. Six values, closed set: an unknown failure kind is `unknown_state`, not a new word. */
export const INCIDENT_CLASSES = [
  'crash',
  'no_progress',
  'tool_error',
  'acceptance_failed',
  /**
   * Not a failure: an operator maintenance settlement bypassed a declared acceptance rule (§8 C1).
   * It earns its own class because rendering it as `acceptance_failed` would claim the check failed,
   * and rendering it as a normal completion is the ambiguity the M5 review blocked on.
   */
  'acceptance_overridden',
  'unknown_state'
] as const
export type IncidentClass = (typeof INCIDENT_CLASSES)[number]

/**
 * §6.2 `status`, plus `closed`.
 *
 * Why `closed` is here although no M1 writer produces it: §11.5's retention rule prunes
 * `closed / invalid / duplicate`, so a status the prune path must name cannot be missing from the
 * vocabulary. `acceptance_pending` is M5's visible stop (§8) and is reserved here so the store does
 * not need a migration the moment acceptance lands.
 */
export const INCIDENT_STATUSES = [
  'untriaged',
  'confirmed',
  'duplicate',
  'invalid',
  'watch',
  'needs_archive',
  'acceptance_pending',
  'closed'
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

/**
 * §6.2 `source_kind`. Only `pty_exit` has a writer in M1; the rest are reserved vocabulary.
 *
 * `tool_error` is not in §6.2's column comment but §6.2.1 spells a `(tool_error, sessionId, tool)`
 * key, so the vocabulary there is incomplete: a tool failure has no other source kind and mapping it
 * onto `dispatch_settle` would lose which session/turn it came from.
 */
export const INCIDENT_SOURCE_KINDS = [
  'pty_exit',
  'status_stall',
  'tool_error',
  'dispatch_settle',
  'acceptance',
  'self_report'
] as const
export type IncidentSourceKind = (typeof INCIDENT_SOURCE_KINDS)[number]

/**
 * Allowed triage moves (§5 R1/R2).
 *
 * Deliberately one-way for the terminal states: re-opening a `duplicate` or `invalid` incident is a
 * new incident (new epoch), not a silent reversal that would erase the original decision's meaning.
 * `confirmed -> closed` exists because M1 has no guardrail gate yet; §8's three-evidence close is an
 * M2+ addition, recorded as a gap rather than pretended here.
 */
export const INCIDENT_STATUS_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> =
  {
    untriaged: ['confirmed', 'duplicate', 'invalid', 'watch', 'needs_archive'],
    confirmed: ['closed', 'watch', 'duplicate', 'invalid', 'needs_archive'],
    watch: ['confirmed', 'duplicate', 'invalid', 'needs_archive'],
    needs_archive: ['confirmed', 'closed', 'invalid'],
    acceptance_pending: ['confirmed', 'duplicate', 'invalid'],
    duplicate: [],
    invalid: [],
    closed: []
  }

/** Statuses that prune may remove (§11.5). Nothing else is ever auto-deleted. */
export const PRUNABLE_STATUSES: readonly IncidentStatus[] = ['closed', 'invalid', 'duplicate']

/** Statuses no decision can leave. */
export const TERMINAL_STATUSES: readonly IncidentStatus[] = ['duplicate', 'invalid', 'closed']

/**
 * Evidence is stored as pointers, never bodies (§6.3): the transcript of a long agent session is
 * gigabytes, and copying it into the store would be both a size problem and a leak surface.
 */
export type IncidentEvidencePointer = {
  kind: 'transcript' | 'status_snapshot' | 'events' | 'command_output' | 'other'
  path: string
  sha256?: string
  startOffset?: number
  endOffset?: number
  /** Lines of context the renderer may read around the offsets. §6.3 caps this at 50. */
  lineWindow?: number
  truncated?: boolean
  /** File size at verification time; `sha256` + `bytes` is what makes a pointer checkable. */
  bytes?: number
}

/**
 * The JSON body of the `evidence` column.
 *
 * `unknownBoundaries` rides here rather than in its own column because §6.2's DDL is the agreed
 * shape and the renderer (§9) requires an "unknown 边界" section regardless.
 */
export type IncidentEvidence = {
  pointers: IncidentEvidencePointer[]
  unknownBoundaries: string[]
  /** A digest of the agent-session identity, when the PTY record carried one. Never a raw id. */
  agentIdentityDigest?: string
  /** Self-report only (§7.5): the required `--code`, kept out of the frozen §6.2 columns. */
  code?: string
  /** Self-report only: the reporter's minimal reproduction, bounded and redacted on write. */
  repro?: string
}

export type IncidentRecord = {
  id: string
  sourceKind: IncidentSourceKind
  /** Stable entity + epoch (§6.2.1). Built by incident-key.ts, never by the store. */
  sourceId: string
  /** Which side of the same source this is: `exit`, `stall`, `verdict`, `rule:<id>`. */
  facet: string
  hostId: string
  worktreeId: string | null
  runId: string | null
  taskId: string | null
  dispatchId: string | null
  agentSessionId: string | null
  ptyIncarnationId: string | null
  class: IncidentClass
  /** Entry status. Always `untriaged` for M1 writers; later rows may start elsewhere. */
  status: IncidentStatus
  exitCause: TerminalExitCause | null
  /** Clustering aid, not part of the unique key (§6.2.1). */
  fingerprint: string
  evidence: IncidentEvidence
  /** Short, already-redacted summary. Bodies never enter this field. */
  summary: string
  createdAt: number
}

export type IncidentDecision = {
  id: string
  incidentId: string
  fromStatus: IncidentStatus
  toStatus: IncidentStatus
  /** Self-reported by the caller (§19.1: no identity verification). */
  actor: string
  reason: string
  createdAt: number
}

/** An incident as the read model returns it: the immutable row plus its projected state. */
export type IncidentView = IncidentRecord & {
  effectiveStatus: IncidentStatus
  decisionCount: number
  lastDecisionAt: number | null
  decisions: IncidentDecision[]
}

/**
 * Coverage gaps the CLI must print (§11.1, §12). `unsupported` is a fixed answer for M1: nothing on
 * this host records an SSH/remote host's incidents, and silence there must not read as "no trouble".
 *
 * Capacity is reported as TWO facts, because they answer different questions and one used to be
 * printed as the other:
 *   * `capacityLatchSet` — this store refused a write at some point. Persists after a prune brings
 *     the store back under its limits; it is history, not a fault.
 *   * `currentlyLimited` — a write *right now* would be refused. This is what "writes are being
 *     refused" may be said about.
 */
export type IncidentCoverage = {
  remoteIncidentCapture: 'unsupported'
  capacityLatchSet: boolean
  currentlyLimited: boolean
  capacity: {
    rows: number
    bytes: number
    maxRows: number
    maxBytes: number
  }
  /**
   * The shadow replay's own state (M2-C4). An empty list plus `incomplete: true` means "we could not
   * finish reading the hints", which must never be rendered as "nothing happened".
   */
  shadowReplay: IncidentShadowReplayCoverage
  /**
   * The pane-clock sampler's last pass (M8-2): how many panes were observed, how many carry an
   * operator declaration, and whether the sampler itself failed. It says nothing about whether a pane
   * is stuck — that judgement lives in the triage skill, not in this process.
   */
  paneClock: IncidentPaneClockCoverage
}

export type IncidentPaneClockCoverage = {
  sampledAt: number | null
  panes: number
  declaredWaits: number
  /** Observations skipped because the epoch was not a finite number. Counted, never written as 0. */
  skipped: number
  /** Sampler passes that threw; `lastError` is the most recent one (M3-C3). */
  errors: number
  lastError: string | null
}

export function isIncidentClass(value: unknown): value is IncidentClass {
  return typeof value === 'string' && (INCIDENT_CLASSES as readonly string[]).includes(value)
}

export function isIncidentStatus(value: unknown): value is IncidentStatus {
  return typeof value === 'string' && (INCIDENT_STATUSES as readonly string[]).includes(value)
}

export function isIncidentSourceKind(value: unknown): value is IncidentSourceKind {
  return typeof value === 'string' && (INCIDENT_SOURCE_KINDS as readonly string[]).includes(value)
}

export function isTerminalStatus(value: IncidentStatus): boolean {
  return TERMINAL_STATUSES.includes(value)
}

export function isPrunableStatus(value: IncidentStatus): boolean {
  return PRUNABLE_STATUSES.includes(value)
}

/** Whether R1 may move an incident between these two statuses. Identity moves are not transitions. */
export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_STATUS_TRANSITIONS[from].includes(to)
}
