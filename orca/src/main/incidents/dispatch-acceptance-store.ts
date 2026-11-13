// Dispatch acceptance declarations, verdicts and the visible stop (issue-sedimentation.md v2.6 §8).
//
// Why this lives in the incidents database rather than orchestration: the orchestration schema is
// frozen at v44 for this milestone, an acceptance expectation is business metadata about a dispatch
// rather than lifecycle state, and the failure has to be expressible as an incident anyway. The
// dispatch's own status stays the orchestration's business — this module never writes it.
//
// Rules are keyed `(host, dispatch, ruleId)` and are idempotent by that key: re-declaring the same rule
// replaces it (the declaration is a contract, not an append-only log). Verdicts are one row per rule,
// replaced on every evaluation, so the gate always reads the latest result.

import { createHash } from 'node:crypto'
import type Database from '../sqlite/sync-database'

export const DISPATCH_ACCEPTANCE_TIMEOUT_MS = 60_000
export const DISPATCH_ACCEPTANCE_MAX_TIMEOUT_MS = 10 * 60_000
export const DISPATCH_ACCEPTANCE_MAX_OUTPUT_BYTES = 512 * 1024

export type AcceptanceExpectation = {
  exitCode?: number
  stdoutMatches?: string
}

export type AcceptanceRule = {
  hostId: string
  dispatchId: string
  ruleId: string
  /** Program + argv, never a shell string (§8's no-interpolation rule). */
  program: string
  args: string[]
  expect: AcceptanceExpectation
  timeoutMs: number
  cwd: string
  actor: string
  createdAt: number
  digest: string
}

export type AcceptanceVerdictKind = 'passed' | 'failed' | 'undeterminable'

export type AcceptanceVerdict = {
  dispatchId: string
  ruleId: string
  verdict: AcceptanceVerdictKind
  exitCode: number | null
  signal: string | null
  stdoutDigest: string | null
  stdoutBytes: number | null
  detail: string | null
  evaluatedAt: number
}

export type DeclareRuleInput = {
  hostId: string
  dispatchId: string
  ruleId: string
  program: string
  args?: string[]
  expect: AcceptanceExpectation
  timeoutMs?: number
  cwd: string
  actor: string
  now?: number
}

export class AcceptanceDeclarationError extends Error {
  constructor(
    readonly reason:
      | 'missing_dispatch'
      | 'missing_rule'
      | 'missing_program'
      | 'missing_actor'
      | 'missing_cwd'
      | 'missing_expectation'
      | 'invalid_timeout'
  ) {
    super(reason)
  }
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DISPATCH_ACCEPTANCE_TIMEOUT_MS
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AcceptanceDeclarationError('invalid_timeout')
  }
  return Math.min(value, DISPATCH_ACCEPTANCE_MAX_TIMEOUT_MS)
}

/** Stable digest of the declaration body, so a changed rule is visibly a different contract. */
export function acceptanceDigest(input: {
  program: string
  args: readonly string[]
  expect: AcceptanceExpectation
  timeoutMs: number
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        program: input.program,
        args: [...input.args],
        expect: input.expect,
        timeoutMs: input.timeoutMs
      }),
      'utf8'
    )
    .digest('hex')
}

function rowToRule(row: Record<string, unknown>): AcceptanceRule {
  return {
    hostId: String(row.host_id),
    dispatchId: String(row.dispatch_id),
    ruleId: String(row.rule_id),
    program: String(row.program),
    args: JSON.parse(String(row.args)) as string[],
    expect: JSON.parse(String(row.expect)) as AcceptanceExpectation,
    timeoutMs: Number(row.timeout_ms),
    cwd: String(row.cwd),
    actor: String(row.actor),
    createdAt: Number(row.created_at),
    digest: String(row.digest)
  }
}

export function declareAcceptanceRule(db: Database.Database, input: DeclareRuleInput): AcceptanceRule {
  const dispatchId = input.dispatchId.trim()
  const ruleId = input.ruleId.trim()
  const program = input.program.trim()
  const actor = input.actor.trim()
  const cwd = input.cwd.trim()
  if (dispatchId.length === 0) {
    throw new AcceptanceDeclarationError('missing_dispatch')
  }
  if (ruleId.length === 0) {
    throw new AcceptanceDeclarationError('missing_rule')
  }
  if (program.length === 0) {
    throw new AcceptanceDeclarationError('missing_program')
  }
  if (actor.length === 0) {
    throw new AcceptanceDeclarationError('missing_actor')
  }
  if (cwd.length === 0) {
    throw new AcceptanceDeclarationError('missing_cwd')
  }
  const exitCode = input.expect.exitCode
  const stdoutMatches = input.expect.stdoutMatches
  if (
    (exitCode === undefined || !Number.isSafeInteger(exitCode)) &&
    (typeof stdoutMatches !== 'string' || stdoutMatches.length === 0)
  ) {
    // §8: at least one expectation, or the rule says nothing and would always pass.
    throw new AcceptanceDeclarationError('missing_expectation')
  }
  const timeoutMs = clampTimeout(input.timeoutMs)
  const args = input.args ?? []
  const now = input.now ?? Date.now()
  const digest = acceptanceDigest({ program, args, expect: input.expect, timeoutMs })
  db.prepare(
    `INSERT INTO dispatch_acceptance_rules
       (host_id, dispatch_id, rule_id, program, args, expect, timeout_ms, cwd, actor, created_at, digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host_id, dispatch_id, rule_id) DO UPDATE SET
       program = excluded.program,
       args = excluded.args,
       expect = excluded.expect,
       timeout_ms = excluded.timeout_ms,
       cwd = excluded.cwd,
       actor = excluded.actor,
       created_at = excluded.created_at,
       digest = excluded.digest`
  ).run(
    input.hostId,
    dispatchId,
    ruleId,
    program,
    JSON.stringify(args),
    JSON.stringify(input.expect),
    timeoutMs,
    cwd,
    actor,
    now,
    digest
  )
  return {
    hostId: input.hostId,
    dispatchId,
    ruleId,
    program,
    args,
    expect: input.expect,
    timeoutMs,
    cwd,
    actor,
    createdAt: now,
    digest
  }
}

export function listAcceptanceRules(db: Database.Database, dispatchId?: string): AcceptanceRule[] {
  const rows =
    dispatchId === undefined
      ? db
          .prepare('SELECT * FROM dispatch_acceptance_rules ORDER BY dispatch_id, rule_id')
          .all()
      : db
          .prepare('SELECT * FROM dispatch_acceptance_rules WHERE dispatch_id = ? ORDER BY rule_id')
          .all(dispatchId)
  return rows.map(rowToRule)
}

export function writeAcceptanceVerdict(db: Database.Database, verdict: AcceptanceVerdict): void {
  db.prepare(
    `INSERT INTO dispatch_acceptance_verdicts
       (dispatch_id, rule_id, verdict, exit_code, signal, stdout_digest, stdout_bytes, detail, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dispatch_id, rule_id) DO UPDATE SET
       verdict = excluded.verdict,
       exit_code = excluded.exit_code,
       signal = excluded.signal,
       stdout_digest = excluded.stdout_digest,
       stdout_bytes = excluded.stdout_bytes,
       detail = excluded.detail,
       evaluated_at = excluded.evaluated_at`
  ).run(
    verdict.dispatchId,
    verdict.ruleId,
    verdict.verdict,
    verdict.exitCode,
    verdict.signal,
    verdict.stdoutDigest,
    verdict.stdoutBytes,
    verdict.detail,
    verdict.evaluatedAt
  )
}

export function listAcceptanceVerdicts(db: Database.Database, dispatchId: string): AcceptanceVerdict[] {
  return db
    .prepare('SELECT * FROM dispatch_acceptance_verdicts WHERE dispatch_id = ? ORDER BY rule_id')
    .all(dispatchId)
    .map((row) => ({
      dispatchId: String(row.dispatch_id),
      ruleId: String(row.rule_id),
      verdict: String(row.verdict) as AcceptanceVerdictKind,
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      signal: row.signal === null ? null : String(row.signal),
      stdoutDigest: row.stdout_digest === null ? null : String(row.stdout_digest),
      stdoutBytes: row.stdout_bytes === null ? null : Number(row.stdout_bytes),
      detail: row.detail === null ? null : String(row.detail),
      evaluatedAt: Number(row.evaluated_at)
    }))
}

export {
  acceptanceGateState,
  getAcceptanceStop,
  openAcceptanceStop,
  resolveAcceptanceStop,
  type AcceptanceGateState,
  type AcceptanceStop,
  type AcceptanceStopState
} from './dispatch-acceptance-stops'
