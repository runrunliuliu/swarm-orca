import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_TASK_RECORDS,
  TASK_RECORDS_MAX_RUNS_PER_BINDING,
  taskRecordRunClaimKey,
  type TaskRecordsState
} from '../../shared/task-records-types'
import { mergeTaskRecordRuns, upsertTaskRecordBinding } from '../../shared/task-records-updates'
import {
  createTaskRecordsLiveRunObserver,
  liveRunFactsKey,
  liveRunObservation,
  recordLiveRunObservation,
  type LiveAgentStatusRow
} from './task-records-live-runs'

/**
 * The live run ledger (issue #53 follow-up): the row written while the agent is
 * still running, so closing its TUI leaves a durable fact instead of a gap.
 *
 * Every expectation is a literal; the record is built through the same public
 * writers the app uses, so nothing here re-derives a fold or a cap.
 */

const TASK_ID = 'task:github:repo-1:issue:31'
const WORKTREE_ID = 'repo-1::/repo/feature'

function bound(overrides: { isArchived?: boolean } = {}): TaskRecordsState {
  const result = upsertTaskRecordBinding(EMPTY_TASK_RECORDS, {
    taskId: TASK_ID,
    hostId: 'local',
    repoId: 'repo-1',
    worktreeId: WORKTREE_ID,
    path: '/repo/feature',
    isArchived: overrides.isArchived ?? false,
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    now: 100
  })
  if (!result.ok) {
    throw new Error('fixture binding refused')
  }
  return result.state
}

function row(overrides: Partial<LiveAgentStatusRow> = {}): LiveAgentStatusRow {
  return {
    paneKey: 'tab-1:1',
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'session-1', transcriptPath: '/tmp/s-1.jsonl' },
    state: 'working',
    stateStartedAt: 1_000,
    agentType: 'claude',
    ...overrides
  }
}

function runsOf(state: TaskRecordsState) {
  return state.byId[TASK_ID].bindings[0].runs ?? []
}

describe('liveRunObservation', () => {
  it('stores a working row with its start and no invented end', () => {
    const observation = liveRunObservation({ row: row(), provider: 'claude', now: 5_000 })

    expect(observation).not.toBeNull()
    expect(observation?.worktreeId).toBe(WORKTREE_ID)
    expect(observation?.run).toEqual({
      key: 'claude|session_id:session-1',
      providerSession: { provider: 'claude', key: 'session_id', id: 'session-1' },
      agentType: 'claude',
      transcriptPath: '/tmp/s-1.jsonl',
      startedAt: 1_000,
      // A run that has not ended states no end, and a working row has no verdict
      // to read: both stay absent rather than becoming `now` or `success`.
      source: 'live-observation',
      recordedAt: 5_000,
      firstSeenAt: 5_000,
      lastSeenAt: 5_000
    })
  })

  it('reads the settled end and verdict of a done row', () => {
    const observation = liveRunObservation({
      row: row({
        state: 'done',
        stateStartedAt: 2_000,
        mainAgent: { state: 'done', outcome: 'failure' }
      }),
      provider: 'claude',
      now: 5_000
    })

    expect(observation?.run.endedAt).toBe(2_000)
    expect(observation?.run.outcome).toBe('failure')
    // `startedAt` is only a run start while the run is working; a settled row's
    // clock is its end, so the two edges never come from one value.
    expect(observation?.run.startedAt).toBeUndefined()
  })

  it('keeps a plain Stop without a verdict unknown', () => {
    const observation = liveRunObservation({
      row: row({ state: 'done', stateStartedAt: 2_000 }),
      provider: 'claude',
      now: 5_000
    })

    expect(observation?.run.outcome).toBeUndefined()
    expect(observation?.run.endedAt).toBe(2_000)
  })

  it('refuses a row it cannot attribute to a binding', () => {
    expect(
      liveRunObservation({ row: row({ worktreeId: undefined }), provider: 'claude', now: 1 })
    ).toBeNull()
    expect(
      liveRunObservation({
        row: row({ providerSession: { key: 'session_id', id: '' } }),
        provider: 'claude',
        now: 1
      })
    ).toBeNull()
    expect(
      liveRunObservation({
        row: row({ providerSession: { id: 'session-1' } }),
        provider: 'claude',
        now: 1
      })
    ).toBeNull()
  })

  it('keeps an agent outside the four usage providers, with no provider guessed', () => {
    const observation = liveRunObservation({
      row: row({ agentType: 'pi' }),
      provider: undefined,
      now: 5_000
    })

    expect(observation?.run.providerSession).toEqual({ key: 'session_id', id: 'session-1' })
    expect(observation?.run.key).toBe('unknown|session_id:session-1')
  })
})

describe('recordLiveRunObservation', () => {
  it('writes the row into the task that binds the workspace', () => {
    const observation = liveRunObservation({ row: row(), provider: 'claude', now: 5_000 })
    if (!observation) {
      throw new Error('fixture row was refused')
    }

    const result = recordLiveRunObservation(bound(), observation, 5_000)

    expect(result.changed).toBe(true)
    expect(runsOf(result.state)).toEqual([observation.run])
  })

  it('keeps one row per claim and lets a later observation fill the end', () => {
    const started = liveRunObservation({ row: row(), provider: 'claude', now: 5_000 })
    const ended = liveRunObservation({
      row: row({
        state: 'done',
        stateStartedAt: 9_000,
        mainAgent: { state: 'done', outcome: 'success' }
      }),
      provider: 'claude',
      now: 10_000
    })
    if (!started || !ended) {
      throw new Error('fixture row was refused')
    }

    const first = recordLiveRunObservation(bound(), started, 5_000)
    const second = recordLiveRunObservation(first.state, ended, 10_000)

    expect(second.changed).toBe(true)
    expect(runsOf(second.state)).toHaveLength(1)
    expect(runsOf(second.state)[0]).toEqual({
      ...started.run,
      endedAt: 9_000,
      outcome: 'success',
      lastSeenAt: 10_000
    })
  })

  it('does not write to a workspace that no task binds', () => {
    const observation = liveRunObservation({
      row: row({ worktreeId: 'repo-1::/repo/other' }),
      provider: 'claude',
      now: 5_000
    })
    if (!observation) {
      throw new Error('fixture row was refused')
    }

    const state = bound()
    expect(recordLiveRunObservation(state, observation, 5_000)).toEqual({
      state,
      changed: false
    })
  })

  it('refuses over the run cap instead of trimming the ledger', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let state = bound()
    for (let index = 0; index < TASK_RECORDS_MAX_RUNS_PER_BINDING; index += 1) {
      const claim = { provider: 'claude' as const, key: 'session_id', id: `seed-${index}` }
      const result = mergeTaskRecordRuns(state, {
        taskId: TASK_ID,
        worktreeId: WORKTREE_ID,
        hostId: 'local',
        runs: [
          {
            key: taskRecordRunClaimKey(claim),
            providerSession: claim,
            source: 'archive-snapshot',
            recordedAt: 200,
            firstSeenAt: 200,
            lastSeenAt: 200
          }
        ],
        now: 200
      })
      if (!result.ok) {
        throw new Error('fixture run refused')
      }
      state = result.state
    }

    const observation = liveRunObservation({ row: row(), provider: 'claude', now: 5_000 })
    if (!observation) {
      throw new Error('fixture row was refused')
    }
    const result = recordLiveRunObservation(state, observation, 5_000)

    // A dropped run row would read as "this workspace did not run that agent", so
    // the write is refused whole and the stored state is untouched.
    expect(result).toEqual({ state, changed: false })
    expect(runsOf(result.state)).toHaveLength(TASK_RECORDS_MAX_RUNS_PER_BINDING)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('createTaskRecordsLiveRunObserver', () => {
  it('writes once while the facts are unchanged and again when they move', () => {
    const record = vi.fn()
    const observer = createTaskRecordsLiveRunObserver({
      providerForPaneKey: () => 'claude',
      record,
      now: () => 5_000
    })

    observer.observe(row())
    // The hook feed publishes per event; the same facts must not save the domain
    // again.
    observer.observe(row())
    expect(record).toHaveBeenCalledTimes(1)

    observer.observe(row({ state: 'done', stateStartedAt: 9_000 }))
    expect(record).toHaveBeenCalledTimes(2)
  })

  it('skips a row it cannot attribute without calling the writer', () => {
    const record = vi.fn()
    const observer = createTaskRecordsLiveRunObserver({
      providerForPaneKey: () => 'claude',
      record,
      now: () => 5_000
    })

    observer.observe(row({ worktreeId: undefined }))
    expect(record).not.toHaveBeenCalled()
  })

  it('keys the fact cache on every fact the row stores', () => {
    const base = liveRunObservation({ row: row(), provider: 'claude', now: 5_000 })
    if (!base) {
      throw new Error('fixture row was refused')
    }
    const moved = liveRunObservation({
      row: row({ state: 'done', stateStartedAt: 9_000 }),
      provider: 'claude',
      now: 5_000
    })
    if (!moved) {
      throw new Error('fixture row was refused')
    }

    expect(liveRunFactsKey(base)).not.toBe(liveRunFactsKey(moved))
    expect(liveRunFactsKey(base)).toBe(liveRunFactsKey({ ...base }))
  })
})
