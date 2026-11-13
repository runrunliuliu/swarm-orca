/**
 * `orca incident acceptance list` wording and scoping (M5 review C8).
 *
 * Two things were wrong and both mislead an operator:
 *   * every row printed every rule on the host, so a one-rule dispatch looked like a three-rule one;
 *   * a `rejected` stop printed "settlement resumes through the existing flow", while a rejection means
 *     the exact opposite — the dispatch stays unsettled until its owner repairs the work.
 */
import { describe, expect, it } from 'vitest'
import { formatAcceptanceList, formatAcceptanceShow } from './incident-acceptance-format'
import type {
  AcceptanceRule,
  AcceptanceStop,
  AcceptanceVerdict
} from '../main/incidents/dispatch-acceptance-store'

const T0 = 1_700_000_000_000

function rule(dispatchId: string, ruleId: string): AcceptanceRule {
  return {
    hostId: 'host-a',
    dispatchId,
    ruleId,
    program: 'npm',
    args: ['test'],
    expect: { exitCode: 0 },
    timeoutMs: 60_000,
    cwd: `/work/${dispatchId}`,
    worktreeRoot: '/work',
    actor: 'alice',
    createdAt: T0,
    digest: 'd'.repeat(64)
  }
}

function stop(dispatchId: string, overrides: Partial<AcceptanceStop> = {}): AcceptanceStop {
  return {
    dispatchId,
    state: 'pending',
    incidentId: 'inc_1',
    openedAt: T0,
    updatedAt: T0,
    actor: null,
    reason: null,
    evaluationAttempts: 1,
    gateSeenCount: 3,
    lastSeenAt: T0 + 3,
    lastError: null,
    overriddenRules: [],
    ...overrides
  }
}

describe('formatAcceptanceList', () => {
  it('prints only the rules that belong to each dispatch row', () => {
    const output = formatAcceptanceList([
      { dispatchId: 'disp_1', rules: [rule('disp_1', 'tests')], stop: null, gate: { state: 'passed' } },
      {
        dispatchId: 'disp_2',
        rules: [rule('disp_2', 'archive'), rule('disp_2', 'lint')],
        stop: null,
        gate: { state: 'passed' }
      }
    ])
    const disp1Block = output.split('\n').filter((line) => line.includes('disp_1'))
    const disp2Block = output.split('\n').filter((line) => line.includes('disp_2'))
    expect(disp1Block.join('\n')).toContain('tests')
    expect(disp1Block.join('\n')).not.toContain('archive')
    expect(disp2Block.join('\n')).toContain('archive')
    expect(disp2Block.join('\n')).toContain('lint')
  })

  it('never says a rejected stop resumes; it says the owner must repair and report', () => {
    const output = formatAcceptanceList([
      {
        dispatchId: 'disp_1',
        rules: [rule('disp_1', 'tests')],
        stop: stop('disp_1', { state: 'rejected', actor: 'alice', reason: 'not done' }),
        gate: { state: 'blocked' }
      }
    ])
    expect(output).not.toContain('resumes')
    expect(output).toContain('REJECTED')
    expect(output.toLowerCase()).toContain('stays unsettled')
    expect(output).toContain('repair')
  })

  it('says an accepted stop needs the coordinator tick, not that it already settled', () => {
    const output = formatAcceptanceList([
      {
        dispatchId: 'disp_1',
        rules: [rule('disp_1', 'tests')],
        stop: stop('disp_1', { state: 'accepted', actor: 'alice', reason: 'verified' }),
        gate: { state: 'passed' }
      }
    ])
    expect(output).toContain('next tick')
    expect(output.toLowerCase()).not.toContain('stays unsettled')
  })

  it('renders an override as a bypass with its actor and skipped rules, never as a pass', () => {
    const output = formatAcceptanceList([
      {
        dispatchId: 'disp_1',
        rules: [rule('disp_1', 'tests')],
        stop: stop('disp_1', {
          state: 'overridden',
          actor: 'oncall',
          reason: 'incident 42',
          overriddenRules: ['tests']
        }),
        gate: { state: 'passed' }
      }
    ])
    expect(output).toContain('overridden by oncall')
    expect(output).toContain('tests')
    expect(output).toContain('settled without acceptance')
  })

  it('gives the resolve command only for a pending blocked stop', () => {
    const pending = formatAcceptanceList([
      {
        dispatchId: 'disp_1',
        rules: [rule('disp_1', 'tests')],
        stop: stop('disp_1'),
        gate: { state: 'blocked' }
      }
    ])
    expect(pending).toContain('acceptance resolve --dispatch disp_1')
  })

  it('names an unreadable store as fail-closed rather than printing an empty result', () => {
    const output = formatAcceptanceList([
      {
        dispatchId: 'disp_1',
        rules: [rule('disp_1', 'tests')],
        stop: stop('disp_1'),
        gate: { state: 'store_unavailable', verdict: 'store_unavailable' }
      }
    ])
    expect(output).toContain('UNREADABLE STORE')
    expect(output).toContain('fail-closed')
  })
})

describe('formatAcceptanceShow', () => {
  it('shows command runs and gate reads separately, plus the override rule list', () => {
    const verdict: AcceptanceVerdict = {
      dispatchId: 'disp_1',
      ruleId: 'tests',
      verdict: 'failed',
      exitCode: 2,
      signal: null,
      stdoutDigest: 'a'.repeat(64),
      stdoutBytes: 12,
      detail: 'exit_code_expected_0_got_2',
      evaluatedAt: T0,
      ruleDigest: 'd'.repeat(64),
      ruleDeclaredAt: T0
    }
    const output = formatAcceptanceShow({
      dispatchId: 'disp_1',
      rules: [rule('disp_1', 'tests')],
      verdicts: [verdict],
      stop: stop('disp_1', { state: 'overridden', overriddenRules: ['tests'], actor: 'oncall' }),
      gate: { state: 'passed' }
    })
    expect(output).toContain('evaluations=1')
    expect(output).toContain('gate_reads=3')
    expect(output).toContain('NOT a product pass')
    // The output body itself is never printed — only its digest and byte count.
    expect(output).toContain('stdout_sha256=')
    expect(output).not.toContain('secret output')
  })
})
