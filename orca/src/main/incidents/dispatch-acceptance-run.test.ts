/**
 * Running acceptance rules (§8, M5-2): pass/fail/timeout/missing-command verdicts, argv-only execution,
 * and no output text in the result.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { AcceptanceRule } from './dispatch-acceptance-store'
import {
  DISPATCH_ACCEPTANCE_TIMEOUT_MS,
  declareAcceptanceRule,
  getAcceptanceStop
} from './dispatch-acceptance-store'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import { gateDispatchSettlement } from './acceptance-gate'
import { evaluateAcceptanceForDispatch } from './acceptance-runtime'
import {
  DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS,
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

  it('passes cwd, argv and the declared timeout through to the runner when the budget allows it', async () => {
    const seen: unknown[] = []
    const runner: AcceptanceRunner = async (spec) => {
      seen.push(spec)
      return run()
    }
    await evaluateAcceptanceRules({
      rules: [rule({ args: ['test', '--reporter=dot'] })],
      runner,
      // Above the declared 60 s, so the aggregate clip (asserted below) cannot mask the pass-through.
      budgetMs: 120_000
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

/**
 * #9: one aggregate evaluation budget, clipped per rule.
 *
 * `orchestration.send` awaits the evaluation inside the RPC, and the client widens its socket timeout
 * for that method to this budget plus its transport grace. A rule's declared timeout may be up to 10
 * minutes and rules run sequentially, so without a shared deadline the transport would die before the
 * settlement the caller asked for — and the caller would get no answer at all instead of a visible
 * reason.
 */
describe('the aggregate evaluation budget', () => {
  it('is the per-rule default timeout, not an independent policy', () => {
    // One source for the number: a rule declaring nothing gets `DISPATCH_ACCEPTANCE_TIMEOUT_MS`, so
    // the budget that bounds all rules has to be exactly that. The client side is pinned where it
    // belongs, in `cli/runtime/client-timeout-policy.test.ts` (it asserts the socket covers this
    // budget plus a real grace), so no copy of the constant is asserted here.
    expect(DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS).toBe(DISPATCH_ACCEPTANCE_TIMEOUT_MS)
  })

  it('clips a rule to the remaining budget and still lets a fast rule pass', async () => {
    const seen: number[] = []
    const runner: AcceptanceRunner = async (spec) => {
      seen.push(spec.timeoutMs)
      return run()
    }
    const verdicts = await evaluateAcceptanceRules({
      rules: [rule({ timeoutMs: 600_000 })],
      runner,
      now: () => T0,
      budgetMs: 5_000
    })
    // Declared ten minutes, given the whole remaining budget — never more.
    expect(seen).toEqual([5_000])
    // Passing inside the budget is unchanged: the clip is not a verdict.
    expect(verdicts[0]).toMatchObject({ verdict: 'passed', detail: 'ok' })
  })

  it('answers every rule the budget cannot accommodate, before the budget, with a typed reason', async () => {
    // A fake clock that advances exactly as long as each run was allowed to take: three rules declaring
    // 60 s each against a 100 ms budget must consume 100 ms, not 180 s.
    let clock = T0
    const asked: number[] = []
    const runner: AcceptanceRunner = async (spec) => {
      asked.push(spec.timeoutMs)
      clock += spec.timeoutMs
      return run({ timedOut: true, code: null })
    }
    const verdicts = await evaluateAcceptanceRules({
      rules: [
        rule({ ruleId: 'a', timeoutMs: 60_000 }),
        rule({ ruleId: 'b', timeoutMs: 60_000 }),
        rule({ ruleId: 'c', timeoutMs: 60_000 })
      ],
      runner,
      now: () => clock,
      budgetMs: 100
    })

    expect(clock - T0).toBe(100)
    // One run only: the first rule was clipped to the whole budget, and by the time it was cut off there
    // was nothing left to start a second one with.
    expect(asked).toEqual([100])
    expect(verdicts.map((verdict) => [verdict.ruleId, verdict.verdict])).toEqual([
      ['a', 'undeterminable'],
      ['b', 'undeterminable'],
      ['c', 'undeterminable']
    ])
    expect(verdicts.map((verdict) => verdict.detail)).toEqual([
      'aggregate_deadline:timeout_after_100ms',
      'aggregate_deadline:not_run',
      'aggregate_deadline:not_run'
    ])
    // Every answer still belongs to the rule revision the gate will compare against (§8 C7).
    for (const verdict of verdicts) {
      expect(verdict.ruleDigest).toBe('d'.repeat(64))
      expect(verdict.ruleDeclaredAt).toBe(T0)
    }
  })

  it('keeps the verdicts of rules that ran before the budget ran out', async () => {
    let clock = T0
    const runner: AcceptanceRunner = async (spec) => {
      clock += spec.timeoutMs
      return run()
    }
    const verdicts = await evaluateAcceptanceRules({
      rules: [
        rule({ ruleId: 'a', timeoutMs: 40 }),
        rule({ ruleId: 'b', timeoutMs: 60 }),
        rule({ ruleId: 'c', timeoutMs: 60 }),
        rule({ ruleId: 'd', timeoutMs: 60 })
      ],
      runner,
      now: () => clock,
      budgetMs: 100
    })

    expect(clock - T0).toBe(100)
    expect(verdicts.map((verdict) => [verdict.ruleId, verdict.verdict, verdict.detail])).toEqual([
      ['a', 'passed', 'ok'],
      ['b', 'passed', 'ok'],
      ['c', 'undeterminable', 'aggregate_deadline:not_run'],
      ['d', 'undeterminable', 'aggregate_deadline:not_run']
    ])
  })
})

describe('a budget-cut evaluation at the settlement gate', () => {
  const directories: string[] = []
  const databases: OpenIncidentsDatabase[] = []

  function incidents(): {
    opened: OpenIncidentsDatabase
    store: ReturnType<typeof createIncidentStore>
  } {
    const directory = mkdtempSync(join(tmpdir(), 'orca-acceptance-budget-'))
    directories.push(directory)
    const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
    databases.push(opened)
    return {
      opened,
      store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
    }
  }

  afterEach(() => {
    for (const opened of databases.splice(0)) {
      try {
        opened.db.close()
      } catch {
        // Already closed.
      }
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks the settlement and leaves the budget reason on the visible stop', async () => {
    const { opened, store } = incidents()
    for (const ruleId of ['a', 'b']) {
      declareAcceptanceRule(opened.db, {
        hostId: 'host-a',
        dispatchId: 'disp-1',
        ruleId,
        program: 'npm',
        args: ['test'],
        expect: { exitCode: 0 },
        // Declared above the budget on purpose: a rule declaring exactly the default is not clipped by
        // a budget derived from that default, so the aggregate-clip detail is only observable when a
        // rule asks for more than the budget (the per-rule cap is 10 minutes).
        timeoutMs: 5 * 60_000,
        cwd: wt.cwd,
        worktreeRoot: wt.root,
        actor: 'alice',
        now: T0
      })
    }
    // The shipped budget, driven by a fake clock: two rules declaring more than the budget cannot both
    // run, and the one that does run is clipped to the budget.
    let clock = T0
    const runner: AcceptanceRunner = async (spec) => {
      clock += spec.timeoutMs
      return run({ timedOut: true, code: null })
    }

    const summary = await evaluateAcceptanceForDispatch('disp-1', {
      runtime: { store, db: opened.db },
      runner,
      now: () => clock
    })

    expect(clock - T0).toBe(DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS)
    expect(summary).toMatchObject({ evaluated: 2, undeterminable: 2, passed: 0 })

    // Fail closed: both rules are undeterminable, so the gate refuses the settlement. The budget reason
    // travels with the verdict and lands on the incident, which is what `incident acceptance show`
    // prints — the operator can see why it blocked, not just that it did.
    const outcome = gateDispatchSettlement({ db: opened.db, store }, 'disp-1')
    expect(outcome.verdict).toBe('blocked')
    expect(outcome.verdict === 'blocked' ? [...outcome.blockedRules].sort() : []).toEqual([
      'a',
      'b'
    ])
    expect(getAcceptanceStop(opened.db, 'disp-1')).toMatchObject({ state: 'pending' })
    const summaries = store.listIncidents().incidents.map((incident) => incident.summary)
    expect(summaries.filter((summary) => summary.includes('aggregate_deadline'))).toHaveLength(2)

    // A retry re-evaluates while the stop is open, and that is where the stop's own `last_error`
    // (`incident acceptance list`) comes from — the reason is on both surfaces.
    clock += 1
    await evaluateAcceptanceForDispatch('disp-1', {
      runtime: { store, db: opened.db },
      runner,
      now: () => clock
    })
    expect(getAcceptanceStop(opened.db, 'disp-1')).toMatchObject({
      state: 'pending',
      lastError: `aggregate_deadline:timeout_after_${DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS}ms`
    })
  })
})
