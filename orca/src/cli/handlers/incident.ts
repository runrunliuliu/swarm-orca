// `orca incident list | show | decide | report | prune` (issue-sedimentation.md v2.3 §12).
//
// Records are local-only (§19.1): a selector that names another machine is refused rather than
// silently answered for this one. Store access lives in incident-store-access.ts, formatting in
// incident-format.ts; this file is flag validation plus the commands.

import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { DEFAULT_INCIDENT_RETENTION_DAYS } from '../../main/incidents/incident-store'
import { isIncidentStatus, type IncidentStatus } from '../../main/incidents/incident-types'
import { renderIncidentMarkdown } from '../../main/incidents/incident-render'
import {
  formatIncidentDecision,
  formatIncidentList,
  formatIncidentPrune,
  formatIncidentShow
} from '../incident-format'
import { openIncidentStore } from '../incident-store-access'
import { reportIncident } from './incident-report'
import { stallsIncident, waitIncident } from './incident-stall'
import { toolErrorsIncident } from './incident-tool-errors'
import { digestIncident } from './incident-digest'
import { mineIncident } from './incident-mine'
import {
  acceptanceDeclareIncident,
  acceptanceListIncident,
  acceptanceResolveIncident,
  acceptanceShowIncident
} from './incident-acceptance'
import {
  parseIncidentClass,
  printIncidentJson,
  refuseNonLocalIncidentSelector,
  stringFlag
} from './incident-shared'

function intFlag(ctx: HandlerContext, name: string): number | null {
  const raw = stringFlag(ctx, name)
  if (raw === null) {
    return null
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RuntimeClientError('invalid_argument', `\`--${name}\` must be a non-negative integer.`)
  }
  return parsed
}

function requireId(ctx: HandlerContext): string {
  const id = stringFlag(ctx, 'id')
  if (id === null) {
    throw new RuntimeClientError('invalid_argument', 'Missing <id>. Run `orca incident list`.')
  }
  return id
}

function parseStatus(value: string, flag: string): IncidentStatus {
  if (!isIncidentStatus(value)) {
    throw new RuntimeClientError('invalid_argument', `Unsupported --${flag} "${value}".`)
  }
  return value
}

function describeDecisionFailure(
  outcome: string,
  id: string,
  fromStatus: IncidentStatus | undefined
): string {
  switch (outcome) {
    case 'not_found':
      return `Incident ${id} not found.`
    case 'status_unchanged':
      return `Incident ${id} is already ${fromStatus}. A decision must change the status.`
    case 'invalid_transition':
      return (
        `Cannot move incident ${id} from ${fromStatus} in one decision. Terminal states ` +
        '(duplicate, invalid, closed) are final; re-open with a new incident instead.'
      )
    case 'actor_required':
      return 'The actor must be non-empty.'
    case 'reason_required':
      return 'The reason must be non-empty.'
    case 'invalid_status':
      return 'Unsupported target status.'
    case 'read_only':
      return `The incident store is read-only (a newer Orca wrote it). Cannot decide ${id} from this build.`
    default:
      return `Could not record the decision for ${id} (${outcome}).`
  }
}

export const INCIDENT_HANDLERS: Record<string, CommandHandler> = {
  'incident list': async (ctx) => {
    refuseNonLocalIncidentSelector(ctx, 'orca incident list')
    const status = stringFlag(ctx, 'status')
    const classFlag = stringFlag(ctx, 'class')
    const opened = openIncidentStore({ requireExisting: false, readOnly: true })
    try {
      const result = opened.store.listIncidents({
        limit: intFlag(ctx, 'limit') ?? 50,
        ...(status !== null ? { status: parseStatus(status, 'status') } : {}),
        ...(classFlag !== null ? { class: parseIncidentClass(classFlag) } : {})
      })
      if (ctx.json) {
        printIncidentJson(result)
        return
      }
      console.log(formatIncidentList(result))
    } finally {
      opened.close()
    }
  },

  'incident show': async (ctx) => {
    refuseNonLocalIncidentSelector(ctx, 'orca incident show')
    const id = requireId(ctx)
    const opened = openIncidentStore({ requireExisting: true, readOnly: true })
    try {
      const view = opened.store.getIncident(id)
      if (!view) {
        throw new RuntimeClientError('invalid_argument', `Incident ${id} not found.`)
      }
      if (ctx.flags.get('md') === true) {
        const markdown = renderIncidentMarkdown(view)
        if (ctx.json) {
          printIncidentJson({ incidentId: view.id, markdown })
          return
        }
        console.log(markdown)
        return
      }
      if (ctx.json) {
        printIncidentJson({ incident: view, coverage: opened.store.coverage() })
        return
      }
      console.log(formatIncidentShow(view, { coverage: opened.store.coverage() }))
    } finally {
      opened.close()
    }
  },

  'incident decide': async (ctx) => {
    refuseNonLocalIncidentSelector(ctx, 'orca incident decide')
    const id = requireId(ctx)
    const toFlag = stringFlag(ctx, 'to')
    if (toFlag === null) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing --to <status>. One of: untriaged, confirmed, duplicate, invalid, watch, needs_archive, acceptance_pending, closed.'
      )
    }
    const toStatus = parseStatus(toFlag, 'to')
    const reason = stringFlag(ctx, 'reason')
    if (reason === null) {
      throw new RuntimeClientError('invalid_argument', 'Missing --reason <text>.')
    }
    const actorFlag = stringFlag(ctx, 'actor')
    if (toStatus === 'confirmed' && actorFlag === null) {
      // §19.1: the one move that must name its author. Never defaulted, because an invented actor
      // would make the audit trail claim a person who did not decide.
      throw new RuntimeClientError(
        'invalid_argument',
        '`--to confirmed` requires --actor <name> (self-reported; it is the audit trail, not a permission check).'
      )
    }
    const actor = actorFlag ?? 'unspecified'
    const opened = openIncidentStore({ requireExisting: true, readOnly: false })
    try {
      const result = opened.store.appendDecision({ incidentId: id, toStatus, actor, reason })
      if (result.outcome !== 'appended') {
        throw new RuntimeClientError(
          'invalid_argument',
          describeDecisionFailure(result.outcome, id, result.fromStatus)
        )
      }
      if (ctx.json) {
        printIncidentJson({
          incidentId: id,
          decisionId: result.decisionId ?? null,
          fromStatus: result.fromStatus ?? null,
          toStatus: result.toStatus ?? toStatus,
          actor
        })
        return
      }
      console.log(
        formatIncidentDecision({
          incidentId: id,
          decisionId: result.decisionId ?? '(unknown)',
          fromStatus: result.fromStatus as IncidentStatus,
          toStatus: result.toStatus ?? toStatus,
          actor
        })
      )
    } finally {
      opened.close()
    }
  },

  'incident report': reportIncident,
  'incident wait': waitIncident,
  'incident stalls': stallsIncident,
  'incident tool-errors': toolErrorsIncident,
  'incident digest': digestIncident,
  'incident mine': mineIncident,
  'incident acceptance declare': acceptanceDeclareIncident,
  'incident acceptance list': acceptanceListIncident,
  'incident acceptance show': acceptanceShowIncident,
  'incident acceptance resolve': acceptanceResolveIncident,

  'incident prune': async (ctx) => {
    refuseNonLocalIncidentSelector(ctx, 'orca incident prune')
    if (ctx.flags.get('dry-run') === true && ctx.flags.get('apply') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        '`--dry-run` and `--apply` are mutually exclusive.'
      )
    }
    const keepDays = intFlag(ctx, 'keep-days') ?? DEFAULT_INCIDENT_RETENTION_DAYS
    const dryRun = ctx.flags.get('apply') !== true
    const opened = openIncidentStore({ requireExisting: true, readOnly: dryRun })
    try {
      const result = opened.store.pruneIncidents({ dryRun, olderThanDays: keepDays })
      if (ctx.json) {
        printIncidentJson(result)
        return
      }
      console.log(formatIncidentPrune(result))
    } finally {
      opened.close()
    }
  }
}
