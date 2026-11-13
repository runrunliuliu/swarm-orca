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
 */
export async function evaluateAcceptanceRules(input: {
  rules: readonly AcceptanceRule[]
  runner?: AcceptanceRunner
  now?: () => number
}): Promise<AcceptanceVerdict[]> {
  const runner = input.runner ?? defaultAcceptanceRunner
  const now = input.now ?? Date.now
  const verdicts: AcceptanceVerdict[] = []
  for (const rule of input.rules) {
    // §8 C5, run time: the declaration was authorized against a worktree root, and the directory graph
    // may have changed since. Re-checking here is what makes a replaced symlink `undeterminable`
    // instead of a run in whatever the link now points at — and it never runs the command.
    const unauthorized = rejectionForRun({ cwd: rule.cwd, worktreeRoot: rule.worktreeRoot })
    if (unauthorized !== null) {
      verdicts.push({
        dispatchId: rule.dispatchId,
        ruleId: rule.ruleId,
        verdict: 'undeterminable',
        exitCode: null,
        signal: null,
        stdoutDigest: null,
        stdoutBytes: 0,
        detail: `cwd_not_authorized:${unauthorized}`,
        evaluatedAt: now(),
        ruleDigest: rule.digest,
        ruleDeclaredAt: rule.createdAt
      })
      continue
    }
    const run = await runner({
      program: rule.program,
      args: rule.args,
      cwd: rule.cwd,
      timeoutMs: rule.timeoutMs,
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
      detail: sanitizeText(decided.detail, 200),
      evaluatedAt: now(),
      // §8 C7: the revision this answer belongs to. The gate refuses a verdict without it.
      ruleDigest: rule.digest,
      ruleDeclaredAt: rule.createdAt
    })
  }
  return verdicts
}
