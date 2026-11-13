/**
 * Running acceptance rules (§8, M5-2): pass/fail/timeout/missing-command verdicts, argv-only execution,
 * and no output text in the result.
 */
import { describe, expect, it } from 'vitest'
import type { AcceptanceRule } from './dispatch-acceptance-store'
import {
  decideAcceptanceVerdict,
  evaluateAcceptanceRules,
  stdoutFingerprint,
  type AcceptanceRunner
} from './dispatch-acceptance-run'

const T0 = 1_700_000_000_000

function rule(overrides: Partial<AcceptanceRule> = {}): AcceptanceRule {
  return {
    hostId: 'host-a',
    dispatchId: 'disp-1',
    ruleId: 'tests',
    program: 'npm',
    args: ['test'],
    expect: { exitCode: 0 },
    timeoutMs: 60_000,
    cwd: '/work/tree',
    actor: 'alice',
    createdAt: T0,
    digest: 'd'.repeat(64),
    ...overrides
  }
}

function run(overrides: Partial<Awaited<ReturnType<AcceptanceRunner>>> = {}) {
  return {
    code: 0,
    signal: null,
    stdout: '',
    timedOut: false,
    spawnFailed: false,
    ...overrides
  }
}

describe('decideAcceptanceVerdict', () => {
  it('passes on the expected exit code and on a stdout match', () => {
    expect(decideAcceptanceVerdict({ rule: rule(), run: run() })).toEqual({
      verdict: 'passed',
      detail: 'ok'
    })
    expect(
      decideAcceptanceVerdict({
        rule: rule({ expect: { stdoutMatches: 'PASS' } }),
        run: run({ stdout: 'all PASS here' })
      })
    ).toMatchObject({ verdict: 'passed' })
  })

  it('fails on a wrong exit code or a missing stdout match, naming the expectation only', () => {
    expect(
      decideAcceptanceVerdict({ rule: rule(), run: run({ code: 2 }) })
    ).toEqual({ verdict: 'failed', detail: 'exit_code_expected_0_got_2' })
    expect(
      decideAcceptanceVerdict({
        rule: rule({ expect: { stdoutMatches: 'PASS' } }),
        run: run({ stdout: 'FAIL' })
      })
    ).toEqual({ verdict: 'failed', detail: 'stdout_mismatch' })
    // Two expectations: both must hold.
    expect(
      decideAcceptanceVerdict({
        rule: rule({ expect: { exitCode: 0, stdoutMatches: 'PASS' } }),
        run: run({ code: 0, stdout: 'FAIL' })
      })
    ).toMatchObject({ verdict: 'failed' })
  })

  it('is undeterminable for a timeout, a signal, or a command that never started', () => {
    expect(
      decideAcceptanceVerdict({ rule: rule(), run: run({ timedOut: true, code: null }) })
    ).toMatchObject({ verdict: 'undeterminable', detail: 'timeout_after_60000ms' })
    expect(
      decideAcceptanceVerdict({ rule: rule(), run: run({ signal: 'SIGKILL' }) })
    ).toMatchObject({ verdict: 'undeterminable', detail: 'signalled:SIGKILL' })
    expect(
      decideAcceptanceVerdict({
        rule: rule({ program: 'definitely-not-a-binary' }),
        run: run({ spawnFailed: true, spawnError: 'Error', code: null })
      })
    ).toMatchObject({ verdict: 'undeterminable', detail: 'spawn_failed:Error' })
  })
})

describe('evaluateAcceptanceRules', () => {
  it('judges each rule independently and keeps only a digest of the output', async () => {
    const runner: AcceptanceRunner = async (spec) =>
      spec.args[0] === 'test' ? run({ stdout: 'secret output' }) : run({ code: 1, stdout: '' })
    const verdicts = await evaluateAcceptanceRules({
      rules: [rule(), rule({ ruleId: 'archive', program: 'cat', args: ['report.json'] })],
      runner,
      now: () => T0
    })
    expect(verdicts.map((verdict) => [verdict.ruleId, verdict.verdict])).toEqual([
      ['tests', 'passed'],
      ['archive', 'failed']
    ])
    for (const verdict of verdicts) {
      expect(verdict.stdoutDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(verdict)).not.toContain('secret output')
    }
  })

  it('passes cwd, argv and the timeout through to the runner, never a shell string', async () => {
    const seen: unknown[] = []
    const runner: AcceptanceRunner = async (spec) => {
      seen.push(spec)
      return run()
    }
    await evaluateAcceptanceRules({
      rules: [rule({ args: ['test', '--reporter=dot'] })],
      runner
    })
    expect(seen).toEqual([
      {
        program: 'npm',
        args: ['test', '--reporter=dot'],
        cwd: '/work/tree',
        timeoutMs: 60_000,
        maxOutputBytes: 512 * 1024
      }
    ])
  })

  it('runs a real argv command through the shared runner (no shell)', async () => {
    const verdicts = await evaluateAcceptanceRules({
      rules: [
        rule({
          program: process.execPath,
          args: ['-e', 'process.stdout.write("PASS")'],
          cwd: process.cwd(),
          expect: { exitCode: 0, stdoutMatches: 'PASS' }
        })
      ]
    })
    expect(verdicts[0]).toMatchObject({ verdict: 'passed', exitCode: 0 })
  })

  it('reports a missing program as undeterminable rather than failed', async () => {
    const verdicts = await evaluateAcceptanceRules({
      rules: [
        rule({ program: 'orca-definitely-not-a-command-xyz', args: [], cwd: process.cwd() })
      ]
    })
    expect(verdicts[0]).toMatchObject({ verdict: 'undeterminable', exitCode: null })
    expect(verdicts[0].detail).toMatch(/^spawn_failed:/)
  })
})

describe('stdoutFingerprint', () => {
  it('is the sha256 and byte length, not the text', () => {
    expect(stdoutFingerprint('PASS')).toMatchObject({ bytes: 4 })
    expect(stdoutFingerprint('PASS').digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
