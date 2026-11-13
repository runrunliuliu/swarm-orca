// Detail-view projections for one incident (§9, §12; M7-B).
//
// Three rules from the design show up here, all as pure functions so they are pinned by tests rather
// than by reading JSX:
//
//   * `unknown` is a first-class value. The drawer shows the exit cause as recorded and never narrows
//     an unprovable stop into "failed" (§2.8, §16);
//   * evidence is pointers only. The drawer renders path + offsets + sha256 and never reads a body —
//     this module has no filesystem access at all, which is what makes that structural (§6.3);
//   * decisions are append-only. The timeline is rendered in recorded order and no projection may
//     collapse two decisions into one "current state" summary (§6.2).
//
// The renderer makes no triage judgement: it reports `status` (entry) separately from `effectiveStatus`
// (projected) so a reader can see that a decision moved the row without the row being rewritten.

import type {
  IncidentDecisionDto,
  IncidentEvidenceDto,
  IncidentEvidencePointerDto
} from '../../../../../shared/incident-api-types'

export type IncidentExitCauseView =
  | { kind: 'signaled'; signal: number | null }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'unknown'; reason: string | null }
  | { kind: 'operator_close' }
  /** No cause recorded at all: a gap, stated as one, never as a clean exit. */
  | { kind: 'not_recorded' }
  /** Something was stored that this shape does not recognise: shown raw rather than guessed. */
  | { kind: 'unrecognised'; raw: string }

/**
 * `exitCause` crosses IPC as `unknown` on purpose (the store keeps whatever `TerminalExitCause`
 * serialized). Its `kind` is the only interpretation this function performs: no inference from an
 * exit code, no "0 means clean" shortcut.
 */
export function incidentExitCauseView(exitCause: unknown): IncidentExitCauseView {
  if (typeof exitCause !== 'object' || exitCause === null) {
    return { kind: 'not_recorded' }
  }
  const record = exitCause as Record<string, unknown>
  switch (record.kind) {
    case 'operator_close':
      return { kind: 'operator_close' }
    case 'signaled':
      return {
        kind: 'signaled',
        signal: typeof record.signal === 'number' ? record.signal : null
      }
    case 'exited':
      return {
        kind: 'exited',
        exitCode: typeof record.exitCode === 'number' ? record.exitCode : null
      }
    case 'unknown':
      return {
        kind: 'unknown',
        reason: typeof record.reason === 'string' ? record.reason : null
      }
    default:
      return { kind: 'unrecognised', raw: safeJson(exitCause) }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A privacy-friendly label for an evidence path: the basename plus one parent, with a leading ellipsis
 * when more of the path was dropped.
 *
 * Why not the real path: evidence paths are absolute and often carry a user name, a project name or a
 * host-specific mount (`/home/<person>/...`, `/mnt/<customer>/...`). The incident record exists to be
 * read and screenshotted; the path is only needed to *open* the file, and the drawer keeps the real
 * value for that one call (`openPath`) plus an explicit copy action. Nothing in the visible text,
 * `title` or `aria-label` may contain it — the redactor does not cover paths, and §6.3 already says
 * evidence is a pointer, not a document.
 */
export function incidentEvidenceDisplayPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return path === '' ? '—' : path
  }
  const tail = segments.slice(-2).join('/')
  return segments.length > 2 ? `…/${tail}` : tail
}

export type IncidentEvidenceRow = {
  kind: IncidentEvidencePointerDto['kind']
  /** The real path. Only for opening/copying — never for display. */
  path: string
  /** What the UI may show: basename plus one parent. */
  displayPath: string
  /** Shortened for the table; the full digest stays in `sha256` for the title/copy affordance. */
  sha256Short: string | null
  sha256: string | null
  bytes: number | null
  /** `12..40` when offsets exist, `null` when the pointer records no window. */
  offsetRange: string | null
  truncated: boolean
}

/**
 * Pointer rows, in store order.
 *
 * Byte offsets are not line numbers: the record never claims a line, so the drawer shows the offsets
 * it has instead of converting them (that would require reading the body, which §6.3 forbids here).
 */
export function incidentEvidenceRows(evidence: IncidentEvidenceDto | null | undefined): IncidentEvidenceRow[] {
  if (!evidence) {
    return []
  }
  return evidence.pointers.map((pointer) => ({
    kind: pointer.kind,
    path: pointer.path,
    displayPath: incidentEvidenceDisplayPath(pointer.path),
    sha256Short: pointer.sha256 === undefined ? null : pointer.sha256.slice(0, 12),
    sha256: pointer.sha256 ?? null,
    bytes: pointer.bytes ?? null,
    offsetRange:
      pointer.startOffset === undefined
        ? null
        : `${pointer.startOffset}..${pointer.endOffset ?? '?'}`,
    truncated: pointer.truncated === true
  }))
}

/**
 * The decision log as a timeline: recorded order (oldest first), each entry kept.
 *
 * `createdAt` decides, `id` breaks ties so two decisions in the same millisecond cannot swap between
 * renders. Nothing is deduplicated: two `watch` decisions are two facts about who looked and when.
 */
export function incidentDecisionTimeline(
  decisions: readonly IncidentDecisionDto[]
): IncidentDecisionDto[] {
  return [...decisions].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
}

/**
 * What a triage attempt produced, as a closed set the drawer can render.
 *
 * Every non-`appended` outcome comes from the host (`appendDecision` / the IPC handler), never from a
 * renderer-side transition table: the panel offers all five actions for any row and shows the host's
 * refusal. That is what keeps one policy in the system instead of two that drift.
 */
export type IncidentDecisionOutcomeView =
  | { kind: 'appended' }
  | { kind: 'actor_required' }
  | { kind: 'reason_required' }
  | { kind: 'invalid_transition' }
  | { kind: 'status_unchanged' }
  | { kind: 'status_changed' }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; detail: string | null }
  | { kind: 'other'; detail: string | null }

export function incidentDecisionOutcomeView(
  outcome: string,
  detail?: string | null
): IncidentDecisionOutcomeView {
  switch (outcome) {
    case 'appended':
      return { kind: 'appended' }
    case 'actor_required':
      return { kind: 'actor_required' }
    case 'reason_required':
      return { kind: 'reason_required' }
    case 'invalid_transition':
      return { kind: 'invalid_transition' }
    case 'status_unchanged':
      return { kind: 'status_unchanged' }
    case 'status_changed':
      return { kind: 'status_changed' }
    case 'not_found':
      return { kind: 'not_found' }
    case 'incident_store_unavailable':
    case 'read_only':
      return { kind: 'unavailable', detail: detail ?? null }
    default:
      return { kind: 'other', detail: detail ?? null }
  }
}
