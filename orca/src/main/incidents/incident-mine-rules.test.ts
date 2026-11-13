/**
 * Mining policy (§10; simplify S3): stable source identity, thresholds, single-entity recurrence.
 *
 * No database here on purpose — these are pure judgements over rows, and keeping the test at that level
 * is what makes the rule edges cheap to pin.
 */
import { describe, expect, it } from 'vitest'
import type { MineRuleRow } from './incident-mine-rules'
import {
  MINE_RULE_ACCEPTANCE_INVARIANT,
  MINE_RULE_CRASH_SIGNALED,
  MINE_RULE_REPEAT_FINGERPRINT,
  countStableSources,
  dispatchIdFromAcceptanceSourceId,
  mineRulesFor,
  paneKeyFromStallSourceId,
  stableSourceIdentity,
  toolErrorSourceParts
} from './incident-mine-rules'

const T0 = 1_700_000_000_000

describe('stable source identity (M6-C1)', () => {
  it('derives a pane key from a stall source id and drops the epoch', () => {
    expect(paneKeyFromStallSourceId('tab-1:leaf-1:1700000000000')).toBe('tab-1:leaf-1')
    expect(paneKeyFromStallSourceId('not-a-pane-key')).toBeNull()
    expect(
      stableSourceIdentity({
        sourceKind: 'status_stall',
        sourceId: 'tab-1:leaf-1:1700000000000',
        facet: 'stall'
      })
    ).toEqual({ dimension: 'pane', key: 'pane:tab-1:leaf-1' })
  })

  it('keeps the session and the code for a tool error, and drops turn/window', () => {
    expect(toolErrorSourceParts('sess-1:turn-2:permission_denied:1700000000000')).toEqual({
      sessionId: 'sess-1',
      code: 'permission_denied'
    })
    expect(
      stableSourceIdentity({
        sourceKind: 'tool_error',
        sourceId: 'sess-1:turn-2:permission_denied:1700000000000',
        facet: 'tool:permission_denied'
      })
    ).toEqual({ dimension: 'session', key: 'session:sess-1:code:permission_denied' })
    // A different turn of the same session is the SAME stable source.
    expect(
      stableSourceIdentity({
        sourceKind: 'tool_error',
        sourceId: 'sess-1:turn-9:permission_denied:1700000005000',
        facet: 'tool:permission_denied'
      })?.key
    ).toBe('session:sess-1:code:permission_denied')
  })

  it('keys acceptance by dispatch + rule, so the attempt is not a source', () => {
    expect(dispatchIdFromAcceptanceSourceId('disp-1:1')).toBe('disp-1')
    expect(
      stableSourceIdentity({
        sourceKind: 'acceptance',
        sourceId: 'disp-1:1',
        facet: 'rule:tests',
        dispatchId: 'disp-1'
      })
    ).toEqual({ dimension: 'dispatch', key: 'dispatch:disp-1:rule:tests' })
    // Two rules on one dispatch stay distinct entities.
    expect(
      stableSourceIdentity({
        sourceKind: 'acceptance',
        sourceId: 'disp-1:1',
        facet: 'rule:lint',
        dispatchId: 'disp-1'
      })?.key
    ).not.toBe('dispatch:disp-1:rule:tests')
  })

  it('falls back session -> worktree -> run for a pty exit, and reports unknown otherwise', () => {
    expect(
      stableSourceIdentity({
        sourceKind: 'pty_exit',
        sourceId: 'inc-1',
        facet: 'exit',
        agentSessionId: 'sess-9',
        worktreeId: 'wt-1'
      })
    ).toEqual({ dimension: 'session', key: 'session:sess-9' })
    expect(
      stableSourceIdentity({
        sourceKind: 'pty_exit',
        sourceId: 'inc-1',
        facet: 'exit',
        worktreeId: 'wt-1',
        runId: 'run-1'
      })
    ).toEqual({ dimension: 'worktree', key: 'worktree:wt-1' })
    expect(
      stableSourceIdentity({
        sourceKind: 'pty_exit',
        sourceId: 'inc-1',
        facet: 'exit',
        runId: 'run-1'
      })
    ).toEqual({ dimension: 'run', key: 'run:run-1' })
    expect(stableSourceIdentity({ sourceKind: 'pty_exit', sourceId: 'inc-1', facet: 'exit' })).toBeNull()
  })

  it('declares self-report out of mining instead of inventing a source', () => {
    expect(
      stableSourceIdentity({ sourceKind: 'self_report', sourceId: 'req-1', facet: 'report' })
    ).toBeNull()
  })
})


describe('candidate rules (constants, not configuration)', () => {
  function row(overrides: Partial<MineRuleRow> = {}): MineRuleRow {
    return {
      id: 'inc_1',
      class: 'crash',
      sourceKind: 'pty_exit',
      sourceId: 'src_1',
      facet: 'exit',
      fingerprint: 'fp',
      createdAt: T0,
      worktreeId: 'wt-a',
      runId: null,
      agentSessionId: null,
      dispatchId: null,
      effectiveStatus: 'untriaged',
      lastDecisionAt: null,
      exitCause: { kind: 'exited', exitCode: 1 },
      ...overrides
    }
  }

  it('promotes 3 rows from 2 distinct ENTITIES, and not 2 rows', () => {
    const sameWorktree = [
      row({ id: 'a', worktreeId: 'wt-a' }),
      row({ id: 'b', worktreeId: 'wt-b' })
    ]
    expect(mineRulesFor(sameWorktree)).toEqual([])
    expect(
      mineRulesFor([
        row({ id: 'a', worktreeId: 'wt-a' }),
        row({ id: 'b', worktreeId: 'wt-b' }),
        row({ id: 'c', worktreeId: 'wt-c' })
      ])
    ).toContain(MINE_RULE_REPEAT_FINGERPRINT)
  })

  it('does not promote 3 rows that are the same entity even with 3 source ids', () => {
    // The epoch lives in source_id; three stalls of one pane are three rows, one entity.
    const rows = [1700000000000, 1700000005000, 1700000009000].map((epoch, index) =>
      row({
        id: `a${index}`,
        class: 'no_progress',
        sourceKind: 'status_stall',
        sourceId: `tab-1:leaf-1:${epoch}`,
        facet: 'stall',
        worktreeId: 'wt-a',
        runId: null,
        exitCause: null
      })
    )
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('promotes 3 stalls from 2 different panes', () => {
    const rows = [
      row({ id: 'a', class: 'no_progress', sourceKind: 'status_stall', sourceId: 'tab-1:leaf-1:100', facet: 'stall', exitCause: null, worktreeId: null, runId: null }),
      row({ id: 'b', class: 'no_progress', sourceKind: 'status_stall', sourceId: 'tab-1:leaf-1:200', facet: 'stall', exitCause: null, worktreeId: null, runId: null }),
      row({ id: 'c', class: 'no_progress', sourceKind: 'status_stall', sourceId: 'tab-2:leaf-2:300', facet: 'stall', exitCause: null, worktreeId: null, runId: null })
    ]
    expect(countStableSources(rows)).toBe(2)
    expect(mineRulesFor(rows)).toContain(MINE_RULE_REPEAT_FINGERPRINT)
  })

  it('does not let one session\'s three turns become a source pattern', () => {
    const rows = [1, 2, 3].map((turn, index) =>
      row({
        id: `t${index}`,
        class: 'tool_error',
        sourceKind: 'tool_error',
        sourceId: `sess-1:turn-${turn}:permission_denied:1700000000000`,
        facet: 'tool:permission_denied',
        worktreeId: null,
        runId: null,
        exitCause: null
      })
    )
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('lets a signalled crash cluster qualify on two rows from two entities', () => {
    const rules = mineRulesFor([
      row({ id: 'a', worktreeId: 'wt-a', exitCause: { kind: 'signaled', signal: 9 } }),
      row({ id: 'b', worktreeId: 'wt-b', exitCause: { kind: 'signaled', signal: 9 } })
    ])
    expect(rules).toEqual([MINE_RULE_CRASH_SIGNALED])
  })

  it('does not promote two signalled crashes of one entity (single-entity recurrence, C2)', () => {
    const rows = [
      row({ id: 'a', worktreeId: 'wt-a', exitCause: { kind: 'signaled', signal: 9 } }),
      row({ id: 'b', worktreeId: 'wt-a', exitCause: { kind: 'signaled', signal: 9 } })
    ]
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('does not use the signalled-crash rule for a plain non-zero exit', () => {
    const rules = mineRulesFor([
      row({ id: 'a', worktreeId: 'wt-a' }),
      row({ id: 'b', worktreeId: 'wt-b' })
    ])
    expect(rules).toEqual([])
  })

  it('lets an acceptance cluster on one invariant qualify on two dispatches', () => {
    const rules = mineRulesFor([
      row({ id: 'a', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:1', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null }),
      row({ id: 'b', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-2:1', facet: 'rule:tests', dispatchId: 'disp-2', worktreeId: null, runId: null, exitCause: null })
    ])
    expect(rules).toEqual([MINE_RULE_ACCEPTANCE_INVARIANT])
  })

  it('does not promote two failures of the same acceptance rule on ONE dispatch (C2)', () => {
    const rows = [
      row({ id: 'a', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:1', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null }),
      row({ id: 'b', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:2', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null })
    ]
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('does not let two acceptance rules share the small-cluster rule', () => {
    const rules = mineRulesFor([
      row({ id: 'a', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:1', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null }),
      row({ id: 'b', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-2:1', facet: 'rule:lint', dispatchId: 'disp-2', worktreeId: null, runId: null, exitCause: null })
    ])
    expect(rules).toEqual([])
  })
})

