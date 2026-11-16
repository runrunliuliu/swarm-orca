// Running an acceptance rule (issue-sedimentation.md v2.6 §8, M5-2).
//
// Execution rules, each a review point:
//   * argv only. `runProcess` takes `program` + `args` and never a shell string, so a dispatch id or a
//     command in the declaration cannot interpolate anything into a shell.
//   * cwd is the declared worktree path; env is the inherited environment (no credentials are added).
//   * bounded: timeout clamps to a maximum, stdout/stderr are capped by the runner, and the record
//     keeps a digest + byte count — never the output text (§8: no full output in an incident).
//   * a missing program, a timeout, or a signal is `undeterminable`, not `failed`: §8 wants those in
//     the same visible stop but with unknown semantics.

import { createHash } from 'node:crypto'
import { runProcess } from '../../shared/child-process/run-process'
import { sanitizeText } from './incident-sanitize'
import { rejectionForRun } from './acceptance-cwd'
import {
  DISPATCH_ACCEPTANCE_MAX_OUTPUT_BYTES,
  type AcceptanceExpectation,
  type AcceptanceRule,
  type AcceptanceVerdict
} from './dispatch-acceptance-store'

export type AcceptanceRunResult = {
  code: number | null
  signal: string | null
  stdout: string
  timedOut: boolean
  /** The process could not be started at all (missing binary, cwd gone). */
  spawnFailed: boolean
  spawnError?: string
}

/**
 * The whole evaluation budget for one `worker_done` report, in milliseconds.
 *
 * Why one aggregate number and not only the per-rule clamp: `orchestration.send` awaits the
 * evaluation before it writes anything, and the CLI's client timeout for that method is the default
 * 60 s (`cli/runtime/client.ts`, the `RuntimeClient` constructor default; `resolveMethodTimeoutMs`
 * gives `orchestration.send` no exception). Rules run one after another, so N declared rules could
 * cost the sum of their timeouts — the socket dies first and the client gets no answer at all.
 *
 * 45 s keeps 15 s of transport grace for the send itself (settlement write, receipt, socket). A rule
 * that genuinely needs its declared 60 s default is therefore cut off, and the answer is a typed
 * `aggregate_deadline:` verdict: the settlement fails closed and the stop says why, which is the
 * visible trade this budget makes.
 *
 * No declaration-side rule-count cap is added here. The budget bounds wall-clock time regardless of
 * N, and a rule the budget cannot accommodate is answered `undeterminable` without being started, so
 * a count cap adds no bound this constant does not already give. A count cap would also need a new
 * `AcceptanceDeclarationError` reason (a new declaration contract) and a deployment-owned number.
 */
export const DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS = 45_000

export type AcceptanceRunner = (spec: {
  program: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
}) => Promise<AcceptanceRunResult>

/** Default runner: the repo's single child-process entry point, argv form, no shell. */
export const defaultAcceptanceRunner: AcceptanceRunner = async (spec) => {
  try {
    const result = await runProcess({
      program: spec.program,
      args: [...spec.args],
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes
    })
    return {
      code: result.code,
      signal: result.signal,
      stdout: result.stdout,
      timedOut: result.timedOut,
      spawnFailed: false
    }
  } catch (error) {
    return {
      code: null,
      signal: null,
      stdout: '',
      timedOut: false,
      spawnFailed: true,
      spawnError: error instanceof Error ? error.name : 'spawn_failed'
    }
  }
}

/**
 * Judge one run against one expectation.
 *
 * `undeterminable` covers everything that says nothing about the product: a spawn failure, a timeout, a
 * signal. Only a completed run can pass or fail, and a rule with two expectations must satisfy both.
 */
export function decideAcceptanceVerdict(input: {
  rule: AcceptanceRule
  run: AcceptanceRunResult
}): { verdict: AcceptanceVerdict['verdict']; detail: string } {
  const { rule, run } = input
  if (run.spawnFailed) {
    return { verdict: 'undeterminable', detail: `spawn_failed:${run.spawnError ?? 'unknown'}` }
  }
  if (run.timedOut) {
    return { verdict: 'undeterminable', detail: `timeout_after_${rule.timeoutMs}ms` }
  }
  if (run.signal !== null) {
    return { verdict: 'undeterminable', detail: `signalled:${run.signal}` }
  }
  const expect: AcceptanceExpectation = rule.expect
  if (expect.exitCode !== undefined && run.code !== expect.exitCode) {
    return { verdict: 'failed', detail: `exit_code_expected_${expect.exitCode}_got_${run.code ?? 'null'}` }
  }
  if (expect.stdoutMatches !== undefined && !run.stdout.includes(expect.stdoutMatches)) {
    // The detail names the expectation, never the output: the match string is the declaration's own.
    return { verdict: 'failed', detail: 'stdout_mismatch' }
  }
  return { verdict: 'passed', detail: 'ok' }
}

/** Digest + byte count of the capped stdout; the text itself is dropped here. */
export function stdoutFingerprint(stdout: string): { digest: string; bytes: number } {
  return {
    digest: createHash('sha256').update(stdout, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(stdout, 'utf8')
  }
}

/**
 * Evaluate every rule of one dispatch, independently.
 *
 * Sequential on purpose: parallel rules would multiply the load a single settlement puts on the host,
 * and a test suite that runs three rules should read as three runs, not one race.
 *
 * Bounded in aggregate, not only per rule (#9): rules run one after another, so without a shared
 * deadline N rules cost roughly the sum of their declared timeouts — more than the client's
 * `orchestration.send` timeout, which would then fail before the settlement it asked for. Each rule is
 * clipped to the remaining budget, and a rule the budget cannot accommodate is answered
 * `undeterminable` with a typed `aggregate_deadline:` detail. That is fail-closed on purpose: the
 * settlement is blocked, the reason is on the acceptance incident, and a later evaluation records it as
 * the stop's `last_error`. A rule that already ran keeps its own verdict, and a rule that finishes
 * inside the budget keeps its pass.
 */
export async function evaluateAcceptanceRules(input: {
  rules: readonly AcceptanceRule[]
  runner?: AcceptanceRunner
  now?: () => number
  /** Override in tests only; the shipped policy is `DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS`. */
  budgetMs?: number
}): Promise<AcceptanceVerdict[]> {
  const runner = input.runner ?? defaultAcceptanceRunner
  const now = input.now ?? Date.now
  const deadline = now() + (input.budgetMs ?? DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS)
  const verdicts: AcceptanceVerdict[] = []
  const undeterminable = (rule: AcceptanceRule, detail: string): AcceptanceVerdict => ({
    dispatchId: rule.dispatchId,
    ruleId: rule.ruleId,
    verdict: 'undeterminable',
    exitCode: null,
    signal: null,
    stdoutDigest: null,
    stdoutBytes: 0,
    detail,
    evaluatedAt: now(),
    ruleDigest: rule.digest,
    ruleDeclaredAt: rule.createdAt
  })
  for (const rule of input.rules) {
    // §8 C5, run time: the declaration was authorized against a worktree root, and the directory graph
    // may have changed since. Re-checking here is what makes a replaced symlink `undeterminable`
    // instead of a run in whatever the link now points at — and it never runs the command.
    const unauthorized = rejectionForRun({ cwd: rule.cwd, worktreeRoot: rule.worktreeRoot })
    if (unauthorized !== null) {
      verdicts.push(undeterminable(rule, `cwd_not_authorized:${unauthorized}`))
      continue
    }
    const remainingMs = deadline - now()
    if (remainingMs <= 0) {
      // Not started at all: that is a different fact from "timed out while running", and an operator
      // needs to know which rule never got its chance.
      verdicts.push(undeterminable(rule, 'aggregate_deadline:not_run'))
      continue
    }
    const timeoutMs = Math.min(rule.timeoutMs, remainingMs)
    const run = await runner({
      program: rule.program,
      args: rule.args,
      cwd: rule.cwd,
      timeoutMs,
      maxOutputBytes: DISPATCH_ACCEPTANCE_MAX_OUTPUT_BYTES
    })
    const decided = decideAcceptanceVerdict({ rule, run })
    const fingerprint = stdoutFingerprint(run.stdout)
    verdicts.push({
      dispatchId: rule.dispatchId,
      ruleId: rule.ruleId,
      verdict: decided.verdict,
      exitCode: run.code,
      signal: run.signal,
      stdoutDigest: fingerprint.digest,
      stdoutBytes: fingerprint.bytes,
      // Detail is a typed reason built from the declaration and the exit status — never output text.
      // A timeout the budget caused names the timeout that actually ran out: reporting
      // `timeout_after_60000ms` for a run clipped to 40 s would be a false statement.
      detail: sanitizeText(
        timeoutMs < rule.timeoutMs && run.timedOut
          ? `aggregate_deadline:timeout_after_${timeoutMs}ms`
          : decided.detail,
        200
      ),
      evaluatedAt: now(),
      // §8 C7: the revision this answer belongs to. The gate refuses a verdict without it.
      ruleDigest: rule.digest,
      ruleDeclaredAt: rule.createdAt
    })
  }
  return verdicts
}
