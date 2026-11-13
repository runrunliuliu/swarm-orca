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
import { authorizeCwd } from '../../main/incidents/acceptance-cwd'
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
      'Missing --cwd <path>: the directory the command runs in.'
    )
  }
  // §8 C5: a declaration is scoped to a worktree root, and the filesystem check happens HERE (the
  // CLI is the only surface that can see this host's directories). The store then re-checks
  // containment structurally, and the runner re-checks the realpath before every spawn.
  const worktreeRootFlag = stringFlag(ctx, 'worktree-root')
  if (worktreeRootFlag === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --worktree-root <path>: the worker worktree root that --cwd must live in. ' +
        'Acceptance commands never run outside a declared worktree root.'
    )
  }
  const authorized = authorizeCwd({ cwd, worktreeRoot: worktreeRootFlag })
  if (!authorized.ok) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Refusing to declare: ${authorized.reason}. ` +
        '--worktree-root must be an existing git worktree root on this host, and --cwd must be that ' +
        'root or a directory inside it (both resolved through realpath).'
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
        cwd: authorized.resolved.cwd,
        worktreeRoot: authorized.resolved.worktreeRoot,
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
  /** The store file exists but could not be opened (corrupt, unreadable, wrong owner). */
  unavailable: boolean
  close: () => void
} {
  try {
    const opened = openIncidentStore({ requireExisting: false, readOnly: true })
    return { db: opened.db, unavailable: false, close: () => opened.close() }
  } catch {
    // C3: reading failure is its own answer. `db: null` without `unavailable` means "no store on this
    // host yet"; this flag means "there is one and we cannot read it", which must not print as empty.
    return { db: null, unavailable: true, close: () => undefined }
  }
}

export const acceptanceListIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident acceptance list')
  const dispatchFilter = stringFlag(ctx, 'dispatch')
  const opened = openReadOnlyStore()
  try {
    if (opened.unavailable) {
      // C3 surface: a host whose incidents store exists but cannot be read is NOT "no trouble".
      // Settlement on that host is fail-closed, and this is where an operator finds out.
      const unavailable = {
        dispatches: [],
        store: 'unavailable' as const,
        note:
          'The incidents store could not be read on this host. Dispatches whose declarations cannot be ' +
          'checked are NOT settled (fail-closed); repair the store or pass --override-acceptance on the ' +
          'maintenance command to record a bypass.'
      }
      if (ctx.json) {
        printIncidentJson({ ...unavailable, actorIsSelfReported: true })
        return
      }
      console.log(unavailable.note)
      return
    }
    const allRules = listAcceptanceRules(opened.db, dispatchFilter ?? undefined)
    const dispatches = [...new Set(allRules.map((rule) => rule.dispatchId))]
    // C8: each row carries only ITS OWN rules. The M5 build passed the whole list to every row, so a
    // dispatch with one rule printed three.
    const rows = dispatches.map((dispatchId) => ({
      dispatchId,
      rules: allRules.filter((rule) => rule.dispatchId === dispatchId),
      stop: getAcceptanceStop(opened.db as NonNullable<typeof opened.db>, dispatchId),
      gate: acceptanceGateState(opened.db as NonNullable<typeof opened.db>, dispatchId)
    }))
    if (ctx.json) {
      printIncidentJson({ dispatches: rows, store: 'ok', actorIsSelfReported: true })
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
    if (opened.unavailable) {
      if (ctx.json) {
        printIncidentJson({
          dispatchId,
          store: 'unavailable',
          rules: [],
          verdicts: [],
          stop: null,
          gate: null,
          actorIsSelfReported: true
        })
        return
      }
      console.log(
        `Cannot read the incidents store on this host, so dispatch ${dispatchId}'s acceptance state is ` +
          'unknown. Settlement of dispatched work is fail-closed while this lasts.'
      )
      return
    }
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
        ? `Accepted ${dispatchId} by ${actor} (self-reported): settlement resumes when the coordinator ` +
            're-reads the unread worker_done on its next tick. This command does not settle the dispatch itself.'
        : `Rejected ${dispatchId} by ${actor} (self-reported): the dispatch STAYS UNSETTLED until its owner ` +
            'repairs the work and reports again. Nothing resumes automatically.'
    )
  } finally {
    opened.close()
  }
}
