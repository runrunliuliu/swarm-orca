import { describe, expect, it } from 'vitest'
import type {
  TaskWorkbenchHistory,
  TaskWorkbenchHistoryRun
} from '@/components/task-workbench/task-workbench-view'
import { mergeTaskRecordHistory } from './task-workbench-history-merge'
import { binding, EMPTY_HISTORY, record, RUN, SESSION } from './task-workbench-history-merge-fixtures'

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
