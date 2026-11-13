/**
 * Running acceptance rules (§8, M5-2): pass/fail/timeout/missing-command verdicts, argv-only execution,
 * and no output text in the result.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AcceptanceRule } from './dispatch-acceptance-store'
import {
  decideAcceptanceVerdict,
  evaluateAcceptanceRules,
  stdoutFingerprint,
  type AcceptanceRunner
} from './dispatch-acceptance-run'

const T0 = 1_700_000_000_000

/**
 * A real worktree root, because the runner re-authorizes `cwd` on every evaluation (C5). Fixtures used
 * to invent `/work/tree`; with the authorization in place that path is correctly `undeterminable`, so
 * the fixture has to be a directory with a `.git` entry — the same shape a linked worktree has.
 */
const directories: string[] = []
function worktree(): { root: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-acceptance-run-'))
  directories.push(root)
  writeFileSync(join(root, '.git'), 'gitdir: /tmp/not-a-real-gitdir\n')
  const cwd = join(root, 'packages', 'app')
  mkdirSync(cwd, { recursive: true })
  // Resolved here so the assertions compare against what the runner will actually see, even when
  // $TMPDIR is itself a symlink (macOS /var -> /private/var).
  return { root: realpathSync(root), cwd: realpathSync(cwd) }
}
const wt = worktree()

// The module-level worktree is shared by every case and must outlive them; only the end of the file
// removes it. (`afterEach` here deleted the fixture before the second case ran.)
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
  directories.length = 0
})

function rule(overrides: Partial<AcceptanceRule> = {}): AcceptanceRule {
  return {
    hostId: 'host-a',
    dispatchId: 'disp-1',
    ruleId: 'tests',
    program: 'npm',
    args: ['test'],
    expect: { exitCode: 0 },
    timeoutMs: 60_000,
    cwd: wt.cwd,
    worktreeRoot: wt.root,
    actor: 'alice',
    createdAt: T0,
    digest: 'd'.repeat(64),
    ...overrides
  }
}

/** The wait-for-missing-on-purpose helpers below need the fixture to outlive `afterEach`. */

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
        // The realpath'd declaration, not the fixture string: the runner authorizes first (C5).
        cwd: wt.cwd,
        timeoutMs: 60_000,
        maxOutputBytes: 512 * 1024
      }
    ])
  })

  it('runs a real argv command through the shared runner (no shell), with a diagnostic on mismatch', async () => {
    // Reviewed as environment-sensitive (M5 C9): the old form ran in `process.cwd()` and asserted only
    // `passed`. It now runs in a temp worktree the test owns, and a mismatch reports the run's own
    // stdout/exit/signal so a failing CI log explains itself instead of just saying "expected passed".
    const verdicts = await evaluateAcceptanceRules({
      rules: [
        rule({
          program: process.execPath,
          args: ['-e', 'process.stdout.write("PASS")'],
          cwd: wt.cwd,
          expect: { exitCode: 0 }
        })
      ]
    })
    const diagnostic = {
      verdict: verdicts[0].verdict,
      exitCode: verdicts[0].exitCode,
      signal: verdicts[0].signal,
      detail: verdicts[0].detail,
      stdoutBytes: verdicts[0].stdoutBytes,
      cwd: wt.cwd,
      node: process.execPath
    }
    expect(verdicts[0].verdict, JSON.stringify(diagnostic)).toBe('passed')
    expect(verdicts[0].exitCode).toBe(0)
    expect(verdicts[0].stdoutBytes).toBe(4)
  })

  it('reports a missing program as undeterminable rather than failed', async () => {
    const verdicts = await evaluateAcceptanceRules({
      rules: [rule({ program: 'orca-definitely-not-a-command-xyz', args: [], cwd: wt.cwd })]
    })
    expect(verdicts[0]).toMatchObject({ verdict: 'undeterminable', exitCode: null })
    expect(verdicts[0].detail).toMatch(/^spawn_failed:/)
  })

  it('refuses to run when cwd escapes the declared worktree root (C5)', async () => {
    const seen: unknown[] = []
    const runner: AcceptanceRunner = async (spec) => {
      seen.push(spec)
      return run()
    }
    const outside = mkdtempSync(join(tmpdir(), 'orca-acceptance-outside-'))
    directories.push(outside)
    const verdicts = await evaluateAcceptanceRules({
      rules: [rule({ cwd: outside })],
      runner
    })
    expect(verdicts[0]).toMatchObject({
      verdict: 'undeterminable',
      detail: 'cwd_not_authorized:cwd_outside_worktree'
    })
    // The decisive part: the command never ran at all.
    expect(seen).toEqual([])
  })
})

describe('stdoutFingerprint', () => {
  it('is the sha256 and byte length, not the text', () => {
    expect(stdoutFingerprint('PASS')).toMatchObject({ bytes: 4 })
    expect(stdoutFingerprint('PASS').digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
