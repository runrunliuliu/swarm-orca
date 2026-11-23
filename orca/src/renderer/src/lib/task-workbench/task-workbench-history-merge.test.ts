import { describe, expect, it } from 'vitest'
import type {
  TaskRecord,
  TaskRecordRun,
  TaskRecordSession,
  TaskUsageSettlement,
  TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import type {
  TaskWorkbenchHistory,
  TaskWorkbenchHistoryRun
} from '@/components/task-workbench/task-workbench-view'
import { mergeTaskRecordHistory } from './task-workbench-history-merge'
import { archivedRowsTokens } from './task-workbench-history-settlement'

const HISTORY: TaskWorkbenchHistory = {
  agents: 2,
  wall: { kind: 'measured', startedAt: 1_000, endedAt: 2_000 },
  tokens: { kind: 'available', tokens: 1_320_000 },
  lastActivityAt: 2_000,
  archivedWorkspaces: 0,
  deletedWorkspaces: 0,
  tokensSource: 'live',
  workspaces: [],
  sessions: [],
  trace: 'none',
  runs: []
}

/**
 * One recorded run, as the snapshot writer stores it (issue #53): written out
 * field by field so a reader can check it against `task-records-types.ts`
 * without following a helper call.
 */
const RUN: TaskRecordRun = {
  key: 'claude|session_id:run-1',
  providerSession: { provider: 'claude', key: 'session_id', id: 'run-1' },
  title: 'Wire the history fold',
  agentType: 'claude',
  startedAt: 5_000,
  endedAt: 8_000,
  messageCount: 12,
  outcome: 'success',
  transcriptPath: '/tmp/transcripts/run-1.jsonl',
  transcriptCheck: { checkedAt: 9_000, presence: 'present' },
  source: 'archive-snapshot',
  recordedAt: 9_000,
  firstSeenAt: 5_000,
  lastSeenAt: 8_000
}

const SESSION: TaskRecordSession = {
  provider: 'claude',
  key: 'session_id',
  id: 's-1',
  agentType: 'claude',
  transcriptPath: '/tmp/transcripts/s-1.jsonl',
  transcriptCheck: { checkedAt: 9_000, presence: 'unverifiable' },
  source: 'backfill',
  recordedAt: 9_000,
  firstSeenAt: 5_000,
  lastSeenAt: 8_000
}

const EMPTY_HISTORY: TaskWorkbenchHistory = {
  ...HISTORY,
  agents: null,
  wall: { kind: 'unknown' },
  tokens: { kind: 'unavailable', reason: 'unattributed' },
  runs: []
}

function binding(
  worktreeId: string,
  overrides: Partial<TaskWorkspaceBinding> = {}
): TaskWorkspaceBinding {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId: 'local',
    path: `/repo/${worktreeId}`,
    isArchived: false,
    boundAt: 1_000,
    boundBy: 'created',
    lastVerifiedAt: 2_000,
    resolvedVia: 'locator',
    sessions: [],
    ...overrides
  }
}

function record(bindings: TaskWorkspaceBinding[]): TaskRecord {
  return {
    taskId: 'task:repo-1:issue:31',
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    bindings,
    intent: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    schemaVersion: 1
  }
}

function settlement(
  worktreeId: string,
  value: TaskUsageSettlement = {
    kind: 'known',
    collectedAt: 3_000,
    scope: 'worktree-rollup',
    worktreeId,
    providers: [{ provider: 'claude', tokens: 420_000, costUsd: 0.7 }],
    estimatedCostUsd: 0.7
  }
): TaskUsageSettlement {
  return value
}

describe('mergeTaskRecordHistory', () => {
  it('leaves a task whose workspaces all still exist exactly as the join reported it', () => {
    expect(
      mergeTaskRecordHistory({
        history: HISTORY,
        existingWorktreeIds: ['wt-feature'],
        record: record([binding('wt-feature')])
      })
    ).toBe(HISTORY)
  })

  it('states the deleted form when no workspace is left, and keeps the unknown facts unknown', () => {
    const merged = mergeTaskRecordHistory({
      history: {
        ...HISTORY,
        agents: null,
        tokens: { kind: 'unavailable', reason: 'unattributed' }
      },
      existingWorktreeIds: [],
      record: record([binding('wt-feature'), binding('wt-other')])
    })

    expect(merged).toEqual(
      expect.objectContaining({
        deletedWorkspaces: 2,
        trace: 'deleted',
        agents: null,
        wall: { kind: 'unknown' },
        runs: []
      })
    )
    expect(merged.workspaces.map((workspace) => workspace.state)).toEqual(['removed', 'removed'])
  })

  it('labels a live archived workspace as archived, not removed', () => {
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([binding('wt-feature', { isArchived: true }), binding('wt-gone')])
    })

    expect(merged.workspaces).toEqual([
      expect.objectContaining({ worktreeId: 'wt-feature', state: 'archived' }),
      expect.objectContaining({ worktreeId: 'wt-gone', state: 'removed' })
    ])
    expect(merged.archivedWorkspaces).toBe(1)
    expect(merged.deletedWorkspaces).toBe(1)
  })

  it('states the deleted form when a removed binding outranks a live archived one', () => {
    // `trace` is task-level: one removed binding wins even with an archived one.
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([binding('wt-feature', { isArchived: true }), binding('wt-gone')])
    })

    expect(merged.trace).toBe('deleted')
  })

  it('uses the settled figures for removed workspaces and marks the source', () => {
    const merged = mergeTaskRecordHistory({
      history: {
        ...HISTORY,
        agents: null,
        tokens: { kind: 'unavailable', reason: 'unattributed' }
      },
      existingWorktreeIds: [],
      record: record([
        binding('wt-feature', { usageSettlement: settlement('wt-feature') }),
        binding('wt-gone', {
          usageSettlement: settlement('wt-gone', {
            kind: 'known',
            collectedAt: 3_000,
            scope: 'worktree-rollup',
            worktreeId: 'wt-gone',
            providers: [{ provider: 'codex', tokens: 80_000, costUsd: null }],
            estimatedCostUsd: null
          })
        })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'available', tokens: 500_000 })
    expect(merged.tokensSource).toBe('settled')
  })

  it('does not turn a missing settlement into zero tokens', () => {
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: [],
      record: record([
        binding('wt-feature', { usageSettlement: settlement('wt-feature') }),
        binding('wt-gone', {
          usageSettlement: {
            kind: 'unavailable',
            collectedAt: 3_000,
            scope: 'worktree-rollup',
            worktreeId: 'wt-gone',
            reason: 'no_matching_session'
          }
        })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'unavailable', reason: 'no_matching_session' })
    expect(merged.tokensSource).toBe('settled')
  })

  it('adds a live total and a settled total only when both are known', () => {
    const live = { ...HISTORY, tokens: { kind: 'available' as const, tokens: 100 } }
    const merged = mergeTaskRecordHistory({
      history: live,
      existingWorktreeIds: ['wt-live'],
      record: record([
        binding('wt-live'),
        binding('wt-gone', { usageSettlement: settlement('wt-gone') })
      ])
    })
    // 100 live + 420_000 settled: the panel says "Total: every run", so a total
    // that covered only one side would be wrong.
    expect(merged.tokens).toEqual({ kind: 'available', tokens: 420_100 })
    expect(merged.tokensSource).toBe('settled')
  })

  it('reports an unknown combined total instead of half of it', () => {
    const merged = mergeTaskRecordHistory({
      history: { ...HISTORY, tokens: { kind: 'unavailable', reason: 'unattributed' } },
      existingWorktreeIds: ['wt-live'],
      record: record([
        binding('wt-live'),
        binding('wt-gone', { usageSettlement: settlement('wt-gone') })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'unavailable', reason: 'unattributed' })
  })

  it('does not call a workspace removed just because it left this task', () => {
    // Still on disk, no longer linked to this task: presence is not provenance.
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: ['wt-other-task'],
      record: record([binding('wt-feature')])
    })

    expect(merged.workspaces).toEqual([expect.objectContaining({ state: 'removed' })])
    expect(
      mergeTaskRecordHistory({
        history: HISTORY,
        existingWorktreeIds: ['wt-feature', 'wt-other-task'],
        record: record([binding('wt-feature')])
      })
    ).toBe(HISTORY)
  })

  it('keeps every recorded session addressable but never resumable', () => {
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: [],
      record: record([
        binding('wt-gone', {
          sessions: [
            {
              provider: 'claude',
              key: 'session_id',
              id: 'abc',
              transcriptPath: '/home/u/.claude/abc.jsonl',
              firstSeenAt: 1_000,
              lastSeenAt: 2_000
            },
            {
              key: 'session_file',
              id: 'pi-1',
              firstSeenAt: 1_000,
              lastSeenAt: 2_000
            }
          ]
        })
      ])
    })

    expect(merged.sessions).toEqual([
      {
        key: 'claude|session_id:abc',
        provider: 'claude',
        hasTranscriptPath: true,
        transcriptPath: '/home/u/.claude/abc.jsonl',
        resumable: false,
        worktreeId: 'wt-gone'
      },
      {
        key: 'unknown|session_file:pi-1',
        hasTranscriptPath: false,
        resumable: false,
        worktreeId: 'wt-gone'
      }
    ])
  })
})

describe('mergeTaskRecordHistory — record-sourced runs (issue #53)', () => {
  it("states an archived workspace's recorded runs, their wall clock and their source", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          runs: [{ ...RUN, source: 'archive-snapshot', recordedAt: 9_000 }],
          sessions: [SESSION],
          usageSettlement: settlement('wt-feature')
        })
      ])
    })

    // A1: the row is the record's, field for field; `trace` is the record's own
    // stored check, never a reader-side guess, and `checkoutPath` is the binding's
    // recorded path (the directory the resume command has to run in).
    expect(merged.runs).toEqual<TaskWorkbenchHistoryRun[]>([
      {
        key: 'claude|session_id:run-1',
        title: 'Wire the history fold',
        agentType: 'claude',
        startedAt: 5_000,
        endedAt: 8_000,
        messageCount: 12,
        outcome: 'success',
        transcriptPath: '/tmp/transcripts/run-1.jsonl',
        trace: { presence: 'present', checkedAt: 9_000 },
        resumable: true,
        checkoutPath: '/repo/wt-feature',
        fromRecord: true
      }
    ])
    expect(merged.historySource).toBe('record')
    expect(merged.trace).toBe('archived')
    // No gap was stored for this binding, and an empty list is not a claim that
    // nothing ran — the run list says that separately.
    expect(merged.gaps).toEqual([])
    // The count and the window follow the rows they are printed above.
    expect(merged.agents).toBe(1)
    expect(merged.wall).toEqual({ kind: 'measured', startedAt: 5_000, endedAt: 8_000 })
    // Sessions stay the removed-workspace list: an archived workspace's rows are
    // the Agents section, and listing its sessions here would show them twice.
    expect(merged.sessions).toEqual([])
  })

  it('does not list a run the live projection already prints, and lets the live row win', () => {
    const liveRun: TaskWorkbenchHistoryRun = {
      key: 'pane-live',
      title: 'Still the current title',
      agentType: 'claude',
      startedAt: 6_000,
      endedAt: 7_000
    }
    const merged = mergeTaskRecordHistory({
      history: { ...EMPTY_HISTORY, agents: 1, runs: [liveRun], historySource: 'live' },
      existingWorktreeIds: ['wt-feature'],
      record: record([binding('wt-feature', { isArchived: true, runs: [RUN] })]),
      // The live pane already speaks for this session id.
      liveRunSessionIds: ['session_id:run-1']
    })

    // One session, one row: the live row stays (its clock and outcome are the
    // current ones) and the frozen observation of the same run is dropped.
    expect(merged.runs).toEqual([liveRun])
    expect(merged.historySource).toBe('live')
    expect(merged.agents).toBe(1)
  })

  it('appends the record runs the live projection cannot speak for', () => {
    const liveRun: TaskWorkbenchHistoryRun = {
      key: 'pane-live',
      title: 'A different agent',
      agentType: 'claude',
      startedAt: 6_000,
      endedAt: 7_000
    }
    const merged = mergeTaskRecordHistory({
      history: { ...EMPTY_HISTORY, agents: 1, runs: [liveRun] },
      existingWorktreeIds: ['wt-feature'],
      record: record([binding('wt-feature', { isArchived: true, runs: [RUN] })]),
      liveRunSessionIds: ['session_id:another']
    })

    expect(merged.runs.map((run) => run.key)).toEqual(['pane-live', 'claude|session_id:run-1'])
    // Both kinds are on the page, so the provenance badge says so instead of
    // claiming the live row is a frozen observation (S7).
    expect(merged.historySource).toBe('mixed')
    expect(merged.agents).toBe(2)
  })

  it('keeps a recorded row readable after the checkout is removed (T5)', () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: [],
      record: record([
        binding('wt-gone', {
          isArchived: true,
          // Backfilled, then the checkout went away: same rows, removed branch.
          runs: [{ ...RUN, source: 'backfill', recordedAt: 9_500 }],
          sessions: [SESSION],
          usageSettlement: settlement('wt-gone')
        })
      ])
    })

    expect(merged.trace).toBe('deleted')
    expect(merged.historySource).toBe('record')
    // No live row is left, so the live count and window stay unknown even though
    // the recorded rows below them are readable.
    expect(merged.agents).toBeNull()
    expect(merged.wall).toEqual({ kind: 'unknown' })
    expect(merged.runs.map((run) => ({ key: run.key, resumable: run.resumable }))).toEqual([
      { key: 'claude|session_id:run-1', resumable: false }
    ])
    expect(merged.sessions).toEqual([
      {
        key: 'claude|session_id:s-1',
        provider: 'claude',
        hasTranscriptPath: true,
        transcriptPath: '/tmp/transcripts/s-1.jsonl',
        trace: { presence: 'unverifiable', checkedAt: 9_000 },
        resumable: false,
        worktreeId: 'wt-gone'
      }
    ])
    // The settlement the record froze is still the figure: not 0, not unknown.
    expect(merged.tokens).toEqual({ kind: 'available', tokens: 420_000 })
    expect(merged.tokensSource).toBe('settled')
  })

  it("keeps a removed row's token figure absent, never 0, when nothing was settled", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: [],
      record: record([binding('wt-gone', { isArchived: true, runs: [RUN] })])
    })

    // The removed branch keeps its existing settlement rule: a removed binding
    // with no settled figure states the reason it has (`no_matching_session`),
    // and the strip marks the figure settled because it is a record fact now.
    expect(merged.tokens).toEqual({ kind: 'unavailable', reason: 'no_matching_session' })
    expect(merged.tokensSource).toBe('settled')
  })
})

describe('mergeTaskRecordHistory — the resume command (issue #53 A2)', () => {
  it('offers the recorded resume command with the checkout it belongs to (A2)', () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          // The session index is the only place a resume command comes from.
          runs: [{ ...RUN, resumeCommand: 'claude --resume run-1' }]
        })
      ])
    })

    expect(merged.runs[0]).toMatchObject({
      resumeCommand: 'claude --resume run-1',
      checkoutPath: '/repo/wt-feature',
      resumable: true,
      fromRecord: true
    })
    // A run with no observed command stays absent: the panel says it has none
    // rather than printing a command this build composed.
    const withoutCommand = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([binding('wt-feature', { isArchived: true, runs: [RUN] })])
    })
    expect(withoutCommand.runs[0].resumeCommand).toBeUndefined()
  })

  it("states a removed row's command but not the offer: the checkout is gone (A2)", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: [],
      record: record([
        binding('wt-gone', { runs: [{ ...RUN, resumeCommand: 'claude --resume run-1' }] })
      ])
    })

    // The fact survives — it is what the record stored — but `resumable: false` is
    // what the panel renders, so a deleted checkout never offers the action.
    expect(merged.runs[0]).toMatchObject({ resumable: false, fromRecord: true })
  })
})

describe('mergeTaskRecordHistory — recorded absences (issue #53 T2/B1)', () => {
  it("states an archived workspace's binding gap instead of an empty run list", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          // The writer looked and stored no runs, and said why: nobody could tell
          // which agent ran here. This must not render as "nothing ever ran".
          runs: [],
          gaps: [{ kind: 'session_unattributable', observedAt: 9_000 }]
        })
      ])
    })

    expect(merged.runs).toEqual([])
    // `standalone`: the workspace has no rows, so this sentence is the whole state
    // — the reading T2 asks for.
    expect(merged.gaps).toEqual([{ kind: 'session_unattributable', standalone: true }])
    expect(merged.historySource).toBe('live')
    expect(merged.trace).toBe('archived')
  })

  it("folds a removed workspace's gaps and a run's own gaps, once each", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: [],
      record: record([
        binding('wt-gone', {
          isArchived: true,
          runs: [
            {
              ...RUN,
              gaps: [
                {
                  kind: 'ambiguous_match',
                  candidateCount: 3,
                  observedAt: 9_000,
                  detail: 'two branches'
                }
              ]
            }
          ],
          gaps: [
            {
              kind: 'ambiguous_match',
              candidateCount: 3,
              observedAt: 9_000,
              detail: 'two branches'
            },
            { kind: 'session_unattributable', candidateCount: 0, observedAt: 9_000 }
          ]
        })
      ])
    })

    // `kind|detail` is the identity the record unions on, so the run's gap and
    // the binding's identical gap print one sentence; the measured `0` survives
    // because it is a count, not an absence.
    // The binding has a run, so its own gaps are provenance notes (`standalone:
    // false`), not a claim that nothing could be attributed.
    expect(merged.gaps).toEqual([
      { kind: 'ambiguous_match', candidateCount: 3, detail: 'two branches', standalone: false },
      { kind: 'session_unattributable', candidateCount: 0, standalone: false }
    ])
  })

  it("reads the same stored gap as provenance once the workspace has rows (seat B's S5 fix)", () => {
    const GAP = { kind: 'session_unattributable' as const, observedAt: 9_000 }
    // The archive moment wrote the gap; the session index then supplied the row.
    const enriched = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          runs: [RUN],
          gaps: [GAP]
        })
      ])
    })
    // A session-only binding is the same case: the derived row is a row.
    const derived = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          sessions: [SESSION],
          gaps: [GAP]
        })
      ])
    })

    expect(enriched.runs).toHaveLength(1)
    expect(enriched.gaps).toEqual([{ kind: 'session_unattributable', standalone: false }])
    expect(derived.runs).toHaveLength(1)
    expect(derived.gaps).toEqual([{ kind: 'session_unattributable', standalone: false }])
  })

  it('keeps both readings when one kind appears resolved and unresolved', () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-quiet', 'wt-loud'],
      record: record([
        binding('wt-quiet', {
          isArchived: true,
          runs: [],
          gaps: [{ kind: 'session_unattributable', observedAt: 1 }]
        }),
        binding('wt-loud', {
          isArchived: true,
          runs: [RUN],
          gaps: [{ kind: 'session_unattributable', observedAt: 1 }]
        })
      ])
    })

    // One stored absence, two workspaces, two readings: the dedupe must not let
    // the resolved one hide the unresolved one.
    expect(merged.gaps).toEqual([
      { kind: 'session_unattributable', standalone: true },
      { kind: 'session_unattributable', standalone: false }
    ])
  })

  it('keeps "no agent could be attributed" apart from "no run recorded"', () => {
    const withGap = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-gap'],
      record: record([
        binding('wt-gap', {
          isArchived: true,
          runs: [],
          gaps: [{ kind: 'session_unattributable', observedAt: 1 }]
        })
      ])
    })
    const withoutFacts = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-quiet'],
      record: record([binding('wt-quiet', { isArchived: true })])
    })

    expect(withGap.runs).toEqual([])
    expect(withGap.gaps).toHaveLength(1)
    // The other binding has neither rows nor a gap: different facts, different
    // rendering. `absent` runs (a v1 binding) is not `[]` either, and here it is
    // also not a claim of absence.
    expect(withoutFacts.gaps).toEqual([])
    expect(withoutFacts.runs).toEqual([])
  })
})

describe('mergeTaskRecordHistory — a session-only record (issue #53 S6)', () => {
  it("derives a row from an archived binding's sessions when no runs were ever stored", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          // A v1 session: the claim and nothing else. `runs` is absent, not [].
          sessions: [
            { provider: 'claude', key: 'session_id', id: 'v1-1', firstSeenAt: 1, lastSeenAt: 2 }
          ]
        })
      ])
    })

    expect(merged.runs).toEqual<TaskWorkbenchHistoryRun[]>([
      {
        key: 'claude|session_id:v1-1',
        resumable: true,
        checkoutPath: '/repo/wt-feature',
        fromRecord: true
      }
    ])
    // The row states the claim and an unknown wall clock — never the epoch, and
    // never "no agent ran".
    expect(merged.runs[0].startedAt).toBeUndefined()
    expect(merged.wall).toEqual({ kind: 'partial' })
    expect(merged.agents).toBe(1)
  })

  it("uses the session's own facts when it has them, and still dedupes against a live row", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          sessions: [SESSION, { key: 'session_id', id: 'v1-live', firstSeenAt: 1, lastSeenAt: 2 }]
        })
      ]),
      liveRunSessionIds: ['session_id:v1-live']
    })

    expect(merged.runs.map((run) => run.key)).toEqual(['claude|session_id:s-1'])
    expect(merged.runs[0]).toMatchObject({
      agentType: 'claude',
      transcriptPath: '/tmp/transcripts/s-1.jsonl',
      trace: { presence: 'unverifiable', checkedAt: 9_000 },
      fromRecord: true
    })
  })

  it('does not derive rows for a binding that stored runs: []', () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          runs: [],
          sessions: [SESSION]
        })
      ])
    })

    // `[]` means the writer looked and stored none; deriving rows from the
    // sessions would resurrect the exact rows the writer refused to attribute.
    expect(merged.runs).toEqual([])
  })
})

describe('mergeTaskRecordHistory — the task total from a settlement (issue #53 S11)', () => {
  it("adds an archived workspace's settlement to the total, once, after a restart", () => {
    // Archive, restart: no card, no live row, and the join therefore has nothing
    // to sum. The record still holds the measured figure.
    const merged = mergeTaskRecordHistory({
      history: { ...EMPTY_HISTORY, tokens: { kind: 'unavailable', reason: 'no_matching_session' } },
      existingWorktreeIds: ['wt-feature'],
      record: record([
        binding('wt-feature', {
          isArchived: true,
          runs: [RUN],
          usageSettlement: settlement('wt-feature')
        })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'available', tokens: 420_000 })
    expect(merged.tokensSource).toBe('settled')
  })

  it('adds the settlement to a live figure without counting the row twice', () => {
    // 1200 is what the live (active) rows measured; the archived workspace's
    // 420 000 comes from its settlement, which the join no longer adds per row.
    const merged = mergeTaskRecordHistory({
      history: { ...HISTORY, tokens: { kind: 'available', tokens: 1_200 } },
      existingWorktreeIds: ['wt-live', 'wt-feature'],
      record: record([
        binding('wt-live'),
        binding('wt-feature', { isArchived: true, usageSettlement: settlement('wt-feature') })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'available', tokens: 421_200 })
    expect(merged.tokensSource).toBe('settled')
  })

  it('stays unknown when a live row exists whose figure nobody measured', () => {
    const merged = mergeTaskRecordHistory({
      history: { ...HISTORY, tokens: { kind: 'unavailable', reason: 'unattributed' } },
      existingWorktreeIds: ['wt-live', 'wt-feature'],
      record: record([
        binding('wt-live'),
        binding('wt-feature', { isArchived: true, usageSettlement: settlement('wt-feature') })
      ])
    })

    // Half a total is not a total: the archived figure is known, the live row's
    // is not, so the strip keeps saying unknown instead of the settlement alone.
    expect(merged.tokens).toEqual({ kind: 'unavailable', reason: 'unattributed' })
    expect(merged.tokensSource).toBe('settled')
  })
})

describe('archivedRowsTokens', () => {
  const known = settlement('wt-feature')

  it('leaves a workspace with no settlement unattributed, never 0', () => {
    expect(archivedRowsTokens({ agentTypes: ['claude'], settlement: undefined })).toEqual([
      { kind: 'unavailable', reason: 'unattributed' }
    ])
  })

  it("quotes the settlement's own reason when it could not settle", () => {
    expect(
      archivedRowsTokens({
        agentTypes: ['claude', 'claude'],
        settlement: {
          kind: 'unavailable',
          collectedAt: 3_000,
          scope: 'worktree-rollup',
          worktreeId: 'wt-feature',
          reason: 'remote_usage_unavailable'
        }
      })
    ).toEqual([
      { kind: 'unavailable', reason: 'remote_host' },
      { kind: 'unavailable', reason: 'remote_host' }
    ])
  })

  it("attributes one row of a provider to that provider's own rollup", () => {
    expect(archivedRowsTokens({ agentTypes: ['claude', 'pi'], settlement: known })).toEqual([
      { kind: 'rollup', tokens: 420_000 },
      // pi is a real agent and not one of the four usage providers, so the split
      // cannot cover it: unknown, with the reason, not the workspace total.
      { kind: 'unavailable', reason: 'unattributed' }
    ])
  })

  it("refuses to split one provider's rollup across two rows", () => {
    expect(
      archivedRowsTokens({ agentTypes: ['claude', 'claude', 'codex'], settlement: known })
    ).toEqual([
      { kind: 'unavailable', reason: 'ambiguous_session' },
      { kind: 'unavailable', reason: 'ambiguous_session' },
      // codex contributed no settled figure at all.
      { kind: 'unavailable', reason: 'unattributed' }
    ])
  })
})

describe('mergeTaskRecordHistory — an agent whose TUI closed (issue #53 follow-up)', () => {
  it("lists a live workspace's recorded run once the pane that ran it is gone", () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature'],
      // The workspace is still open: only the pane is gone. That is why the run
      // is not `Removed` — its checkout is right there to resume into.
      record: record([binding('wt-feature', { runs: [{ ...RUN, source: 'live-observation' }] })])
    })

    expect(merged.runs).toEqual<TaskWorkbenchHistoryRun[]>([
      {
        key: 'claude|session_id:run-1',
        title: 'Wire the history fold',
        agentType: 'claude',
        startedAt: 5_000,
        endedAt: 8_000,
        messageCount: 12,
        outcome: 'success',
        transcriptPath: '/tmp/transcripts/run-1.jsonl',
        trace: { presence: 'present', checkedAt: 9_000 },
        resumable: true,
        checkoutPath: '/repo/wt-feature',
        fromRecord: true
      }
    ])
    expect(merged.historySource).toBe('record')
    // The workspace row stays absent: nothing left the store and nothing is put
    // away, so the section may not claim an archived or removed workspace.
    expect(merged.workspaces).toEqual([])
    expect(merged.archivedWorkspaces).toBe(0)
    expect(merged.deletedWorkspaces).toBe(0)
    expect(merged.trace).toBe('none')
    // The facts line covers the rows under it, including the folded one.
    expect(merged.agents).toBe(1)
    expect(merged.wall).toEqual({ kind: 'measured', startedAt: 5_000, endedAt: 8_000 })
  })

  it('leaves the join untouched when every recorded run is still on screen', () => {
    const liveRun: TaskWorkbenchHistoryRun = {
      key: 'pane-live',
      title: 'Still running',
      agentType: 'claude',
      startedAt: 6_000
    }
    const history: TaskWorkbenchHistory = {
      ...EMPTY_HISTORY,
      agents: 1,
      runs: [liveRun],
      historySource: 'live'
    }

    expect(
      mergeTaskRecordHistory({
        history,
        existingWorktreeIds: ['wt-feature'],
        record: record([binding('wt-feature', { runs: [{ ...RUN, source: 'live-observation' }] })]),
        liveRunSessionIds: ['session_id:run-1']
      })
    ).toBe(history)
  })

  it('does not derive rows from a live binding whose sessions were never turned into runs', () => {
    const history: TaskWorkbenchHistory = { ...EMPTY_HISTORY, agents: null }
    // `runs` absent means no build observed this workspace's runs; the live
    // projection is the only row source, and the panel must not invent one from
    // the removal-era session list.
    expect(
      mergeTaskRecordHistory({
        history,
        existingWorktreeIds: ['wt-feature'],
        record: record([binding('wt-feature', { sessions: [SESSION] })])
      })
    ).toBe(history)
  })

  it('lists both the closed run and an archived workspace of the same task', () => {
    const merged = mergeTaskRecordHistory({
      history: EMPTY_HISTORY,
      existingWorktreeIds: ['wt-feature', 'wt-archive'],
      record: record([
        binding('wt-feature', { runs: [{ ...RUN, source: 'live-observation' }] }),
        binding('wt-archive', {
          isArchived: true,
          runs: [
            {
              ...RUN,
              key: 'claude|session_id:run-2',
              providerSession: { provider: 'claude', key: 'session_id', id: 'run-2' },
              source: 'archive-snapshot'
            }
          ]
        })
      ])
    })

    expect(merged.runs.map((run) => run.key)).toEqual([
      'claude|session_id:run-2',
      'claude|session_id:run-1'
    ])
    expect(merged.runs.every((run) => run.resumable)).toBe(true)
    expect(merged.historySource).toBe('record')
    expect(merged.archivedWorkspaces).toBe(1)
    expect(merged.trace).toBe('archived')
  })
})
