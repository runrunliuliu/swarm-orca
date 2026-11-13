// `orca incident acceptance declare|list|show|resolve` (issue-sedimentation.md v2.6 §8; M5-1/M5-4).
//
// Declarations are business expectations about a dispatch, stored in the incidents database. The CLI
// is a local-trust surface: there is no identity check (§19.1), so every output states that the actor
// is self-reported and is kept for the audit trail only. Nothing here settles a dispatch — `resolve`
// records the operator's decision and leaves settlement to the existing flow, and no command in this
// file can call `failDispatch`.

import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import {
  AcceptanceDeclarationError,
  declareAcceptanceRule,
  getAcceptanceStop,
  listAcceptanceRules,
  listAcceptanceVerdicts,
  resolveAcceptanceStop
} from '../../main/incidents/dispatch-acceptance-store'
import { acceptanceGateState } from '../../main/incidents/dispatch-acceptance-stops'
import { resolveLocalHostId } from '../../main/incidents/incidents-paths'
import {
  formatAcceptanceDeclared,
  formatAcceptanceList,
  formatAcceptanceShow
} from '../incident-acceptance-format'
import {
  printIncidentJson,
  refuseNonLocalIncidentSelector,
  stringFlag
} from './incident-shared'
import { getRepeatedStringFlag } from '../flags'

function requireDispatch(ctx: HandlerContext): string {
  const dispatch = stringFlag(ctx, 'dispatch')
  if (dispatch === null) {
    throw new RuntimeClientError('invalid_argument', 'Missing --dispatch <id>.')
  }
  return dispatch
}

function intFlag(ctx: HandlerContext, name: string): number | null {
  const raw = stringFlag(ctx, name)
  if (raw === null) {
    return null
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be an integer.`)
  }
  return parsed
}

export const acceptanceDeclareIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident acceptance declare')
  const dispatchId = requireDispatch(ctx)
  const ruleId = stringFlag(ctx, 'rule')
  if (ruleId === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --rule <id>. The rule id is the declaration\'s idempotency key.'
    )
  }
  const command = getRepeatedStringFlag(ctx.flags, 'command')
  if (command.length === 0 || command.some((part) => part.length === 0)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --command. Pass the program first, then one --command per argument ' +
        '(e.g. --command npm --command test); no shell is involved.'
    )
  }
  const cwd = stringFlag(ctx, 'cwd')
  if (cwd === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --cwd <path>: the worker worktree the command runs in.'
    )
  }
  const expectExit = intFlag(ctx, 'expect-exit')
  const expectStdout = stringFlag(ctx, 'expect-stdout')
  if (expectExit === null && expectStdout === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'At least one expectation is required: --expect-exit <n> and/or --expect-stdout <substring>.'
    )
  }
  const actor = stringFlag(ctx, 'actor') ?? 'unspecified'
  const opened = openIncidentStore({ requireExisting: false, readOnly: false, createIfMissing: true })
  try {
    if (opened.db === null) {
      throw new RuntimeClientError('runtime_unavailable', 'The incident store is unavailable.')
    }
    let rule
    try {
      rule = declareAcceptanceRule(opened.db, {
        hostId: resolveLocalHostId(),
        dispatchId,
        ruleId,
        program: command[0],
        args: command.slice(1),
        expect: {
          ...(expectExit === null ? {} : { exitCode: expectExit }),
          ...(expectStdout === null ? {} : { stdoutMatches: expectStdout })
        },
        ...(intFlag(ctx, 'timeout-ms') === null
          ? {}
          : { timeoutMs: intFlag(ctx, 'timeout-ms') as number }),
        cwd,
        actor
      })
    } catch (error) {
      if (error instanceof AcceptanceDeclarationError) {
        throw new RuntimeClientError('invalid_argument', `Invalid declaration (${error.reason}).`)
      }
      throw error
    }
    if (ctx.json) {
      printIncidentJson({ rule, actorIsSelfReported: true })
      return
    }
    console.log(formatAcceptanceDeclared(rule))
  } finally {
    opened.close()
  }
}

function openReadOnlyStore(): {
  db: NonNullable<ReturnType<typeof openIncidentStore>['db']> | null
  close: () => void
} {
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  return { db: opened.db, close: () => opened.close() }
}

export const acceptanceListIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident acceptance list')
  const dispatchFilter = stringFlag(ctx, 'dispatch')
  const opened = openReadOnlyStore()
  try {
    const rules = opened.db === null ? [] : listAcceptanceRules(opened.db, dispatchFilter ?? undefined)
    const dispatches = [...new Set(rules.map((rule) => rule.dispatchId))]
    const rows = dispatches.map((dispatchId) => ({
      dispatchId,
      rules,
      stop: opened.db === null ? null : getAcceptanceStop(opened.db, dispatchId),
      gate: opened.db === null ? null : acceptanceGateState(opened.db, dispatchId)
    }))
    if (ctx.json) {
      printIncidentJson({ dispatches: rows, actorIsSelfReported: true })
      return
    }
    console.log(formatAcceptanceList(rows))
  } finally {
    opened.close()
  }
}

export const acceptanceShowIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident acceptance show')
  const dispatchId = requireDispatch(ctx)
  const opened = openReadOnlyStore()
  try {
    const rules = opened.db === null ? [] : listAcceptanceRules(opened.db, dispatchId)
    const verdicts = opened.db === null ? [] : listAcceptanceVerdicts(opened.db, dispatchId)
    const stop = opened.db === null ? null : getAcceptanceStop(opened.db, dispatchId)
    const gate = opened.db === null ? null : acceptanceGateState(opened.db, dispatchId)
    if (ctx.json) {
      printIncidentJson({ dispatchId, rules, verdicts, stop, gate, actorIsSelfReported: true })
      return
    }
    console.log(formatAcceptanceShow({ dispatchId, rules, verdicts, stop, gate }))
  } finally {
    opened.close()
  }
}

export const acceptanceResolveIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident acceptance resolve')
  const dispatchId = requireDispatch(ctx)
  const accept = ctx.flags.get('accept') === true
  const reject = ctx.flags.get('reject') === true
  if (accept === reject) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --accept or --reject.'
    )
  }
  const actor = stringFlag(ctx, 'actor')
  if (actor === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --actor <name> (self-reported; the stop decision must name who made it).'
    )
  }
  const reason = stringFlag(ctx, 'reason')
  if (reason === null) {
    throw new RuntimeClientError('invalid_argument', 'Missing --reason <text>.')
  }
  const opened = openIncidentStore({ requireExisting: false, readOnly: false, createIfMissing: true })
  try {
    const db = opened.db
    if (db === null) {
      throw new RuntimeClientError('runtime_unavailable', 'The incident store is unavailable.')
    }
    const existing = getAcceptanceStop(db, dispatchId)
    if (existing === null) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Dispatch ${dispatchId} has no acceptance stop to resolve.`
      )
    }
    if (existing.state !== 'pending') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Dispatch ${dispatchId} acceptance is already ${existing.state}.`
      )
    }
    const stop = resolveAcceptanceStop(db, {
      dispatchId,
      decision: accept ? 'accept' : 'reject',
      actor,
      reason,
      now: Date.now()
    })
    if (ctx.json) {
      printIncidentJson({ stop, accepted: accept, actorIsSelfReported: true })
      return
    }
    console.log(
      accept
        ? `Accepted ${dispatchId}: settlement may resume through the existing flow (actor=${actor}, self-reported).`
        : `Rejected ${dispatchId}: it stays unsettled and returns to its owner (actor=${actor}, self-reported).`
    )
  } finally {
    opened.close()
  }
}
