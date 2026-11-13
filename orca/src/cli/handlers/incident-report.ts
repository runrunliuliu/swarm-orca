// `orca incident report` (issue-sedimentation.md v2.3 §7.5).
//
// Extracted from handlers/incident.ts to keep both files inside the max-lines budget, and because
// the write command has its own rules: class + code are mandatory, evidence paths are verified
// before they are stored, and the record is written through the same store + shadow path as a crash.

import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import {
  EvidenceFileError,
  MAX_EVIDENCE_BYTES,
  evidencePointerForFile,
  recordSelfReportTo
} from '../../main/incidents/incident-report'
import type { IncidentEvidencePointer } from '../../main/incidents/incident-types'
import { formatIncidentReport } from '../incident-format'
import { stageIncidentEvidence } from '../../main/incidents/incident-archive'
import { openIncidentStore } from '../incident-store-access'
import { getRepeatedStringFlag } from '../flags'
import { getDefaultUserDataPath } from '../runtime/metadata'
import {
  parseIncidentClass,
  printIncidentJson,
  refuseNonLocalIncidentSelector,
  stringFlag
} from './incident-shared'

/** Bounded so a shell glob cannot turn one report into thousands of hashed pointers. */
const MAX_EVIDENCE_POINTERS = 8

/**
 * Evidence pointers are verified here, at the CLI boundary, because a pointer to a file that is not
 * there reads like evidence later. A bad path is refused (with the path named) instead of being
 * stored as `unknown`: the reporter is present and can fix it.
 */
function evidencePointersFromFlags(ctx: HandlerContext): IncidentEvidencePointer[] {
  const paths = getRepeatedStringFlag(ctx.flags, 'evidence')
  if (paths.length > MAX_EVIDENCE_POINTERS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `At most ${MAX_EVIDENCE_POINTERS} --evidence paths per report (got ${paths.length}).`
    )
  }
  return paths.map((path) => {
    try {
      return evidencePointerForFile(path)
    } catch (error) {
      if (error instanceof EvidenceFileError) {
        if (error.reason === 'evidence_too_large') {
          throw new RuntimeClientError(
            'invalid_argument',
            `--evidence ${path} is ${error.bytes ?? '?'} bytes, over the ${MAX_EVIDENCE_BYTES}-byte ` +
              'per-file cap. Store the slice that matters as a separate file, or omit --evidence.'
          )
        }
        const detail =
          error.reason === 'evidence_not_a_file'
            ? 'is not a regular file'
            : error.reason === 'evidence_unreadable'
              ? 'could not be read'
              : 'does not exist'
        throw new RuntimeClientError(
          'invalid_argument',
          `--evidence ${path} ${detail}. Point at a file that exists on this host.`
        )
      }
      throw error
    }
  })
}

export const reportIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident report')
  const classFlag = stringFlag(ctx, 'class')
  if (classFlag === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --class <class>. One of: crash, no_progress, tool_error, acceptance_failed, unknown_state.'
    )
  }
  const incidentClass = parseIncidentClass(classFlag)
  const code = stringFlag(ctx, 'code')
  if (code === null) {
    // §7.5: class and code are both mandatory for a record to be triageable at all.
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --code <code>. A short stable token for the failure (e.g. `tool_schema_mismatch`).'
    )
  }
  const pointers = evidencePointersFromFlags(ctx)
  const userDataPath = getDefaultUserDataPath()
  const opened = openIncidentStore({
    requireExisting: false,
    readOnly: false,
    createIfMissing: true
  })
  try {
    const result = recordSelfReportTo(
      opened.store,
      {
        class: incidentClass,
        code,
        ...(stringFlag(ctx, 'summary') !== null
          ? { summary: stringFlag(ctx, 'summary') as string }
          : {}),
        ...(stringFlag(ctx, 'repro') !== null
          ? { repro: stringFlag(ctx, 'repro') as string }
          : {}),
        ...(stringFlag(ctx, 'source-id') !== null
          ? { sourceId: stringFlag(ctx, 'source-id') as string }
          : {}),
        evidencePointers: pointers
      },
      // The CLI appends one line per command instead of holding the runtime's rotating sink.
      { userDataPath, shadowMode: 'append' }
    )
    if (result.outcome !== 'inserted' && result.outcome !== 'duplicate') {
      throw new RuntimeClientError(
        result.outcome === 'capacity_limited' ? 'invalid_argument' : 'runtime_unavailable',
        result.outcome === 'capacity_limited'
          ? 'The incident store is at its capacity limit: non-crash incidents are being refused. ' +
            'Triage and run `orca incident prune --apply` first.'
          : `Could not record the report (${result.outcome}).`
      )
    }
    // Evidence bodies are staged locally (bounded, small) and moved to the archive later by the
    // runtime drain. `persistIncidentRecord` already wrote the pointer; the staging write must not
    // change the report's outcome, so a failure there is recorded as `archive_incomplete` instead.
    if (result.outcome === 'inserted' && result.id !== null && opened.db !== null && pointers.length > 0) {
      stageIncidentEvidence({
        db: opened.db,
        incidentId: result.id,
        pointers,
        userDataPath,
        now: Date.now()
      })
    }
    const payload = {
      incidentId: result.id,
      outcome: result.outcome,
      class: incidentClass,
      code,
      shadow: result.shadow
    }
    if (ctx.json) {
      printIncidentJson(payload)
      return
    }
    console.log(formatIncidentReport(payload))
  } finally {
    opened.close()
  }
}
