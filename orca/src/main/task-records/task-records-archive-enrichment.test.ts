import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type {
  TaskRecordSession,
  TaskRecordsState,
  TaskUsageSettlement
} from '../../shared/task-records-types'
import { setTaskRecordBindingSettlement } from '../../shared/task-records-updates'
import { completeArchiveSnapshot } from './task-records-archive-enrichment'
import type { ArchiveSnapshotFollowUp } from './task-records-archive-snapshot'
import type { createTranscriptCheckProbe } from './task-records-transcript-check'
import {
  archive,
  applied,
  bind,
  bindingOf,
  checkedSession,
  claudeSession,
  indexSession,
  recordOf,
  runtime,
  source,
  ID,
  SCHEDULING,
  TASK_ID,
  TRANSCRIPT_CHECK,
  type FixtureRuntime
} from './task-records-archive-snapshot-test-fixtures'

/**
 * Step 2 of the archive snapshot: the asynchronous enrichment. Split from
 * `task-records-archive-snapshot.test.ts` (which owns the synchronous transition)
 * because the two writers are two modules; the fixtures are shared so neither file
 * can drift into a binding shape the production code would not write.
 *
 * The one observation every test here depends on: the module must read
 * `runtime.state.taskRecords` **after** its last `await`, and apply both merges in
 * one synchronous block, or a write that lands mid-flight is lost (S4).
 */

// A real `WriteSchedulingOperations` owns a debounce timer and a profile-state
// authority, neither of which is the subject; a save is observed as one call.
const scheduled = vi.hoisted(() => vi.fn())
vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: scheduled }))

afterEach(() => {
  scheduled.mockClear()
  vi.restoreAllMocks()
})

describe('archive snapshot: the degraded source', () => {
  function boundState(): { rt: FixtureRuntime; followUp: ArchiveSnapshotFollowUp } {
    const rt = runtime()
    const binding = bind(rt)
    const { state, followUp } = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: source([]), lookup: 'pending' })
    )
    rt.state.taskRecords = state
    if (!followUp) {
      throw new Error('expected a followUp lookup')
    }
    // A coherent window: the transition instant is *after* the binding, which is
    // what the real write path produces (`boundAt <= now`).
    return { rt, followUp: { ...followUp, recordedAt: followUp.windowStart + 5_000 } }
  }

  /** A session dated inside the binding's own window: `boundAt` is a real
   *  `Date.now()` from the write path, so a fixed calendar instant would fall
   *  before it and be (correctly) filtered out. */
  function sessionFor(
    followUp: ArchiveSnapshotFollowUp,
    overrides: Partial<AiVaultSession> = {}
  ): AiVaultSession {
    const startedAt = followUp.windowStart + 1_000
    return indexSession({
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(followUp.recordedAt).toISOString(),
      modifiedAt: new Date(followUp.recordedAt).toISOString(),
      ...overrides
    })
  }

  function deps(
    sessions: AiVaultSession[],
    check: Awaited<ReturnType<ReturnType<typeof createTranscriptCheckProbe>>> = {
      checkedAt: 700,
      presence: 'present'
    }
  ) {
    return { sessionIndexLookup: async () => sessions, transcriptCheck: async () => check }
  }

  it('completes the snapshot from exactly one hit, with the same recordedAt', async () => {
    const { rt, followUp } = boundState()

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: deps([sessionFor(followUp)], {
        checkedAt: 700,
        presence: 'present',
        dev: 2_049,
        ino: 7,
        mtimeMs: 1_000,
        size: 4_096
      })
    })

    const written = bindingOf(recordOf(rt.state.taskRecords))
    expect(written.sessions).toEqual([
      expect.objectContaining({
        provider: 'claude',
        key: 'session_id',
        id: 'abc',
        agentType: 'claude',
        title: 'Fix the archive snapshot',
        messageCount: 12,
        transcriptPath: '/home/u/abc.jsonl',
        startedAt: followUp.windowStart + 1_000,
        endedAt: followUp.recordedAt,
        source: 'archive-snapshot',
        recordedAt: followUp.recordedAt,
        transcriptCheck: {
          checkedAt: 700,
          presence: 'present',
          dev: 2_049,
          ino: 7,
          mtimeMs: 1_000,
          size: 4_096
        }
      })
    ])
    expect(written.runs).toEqual([
      expect.objectContaining({
        key: 'claude|session_id:abc',
        source: 'archive-snapshot',
        recordedAt: followUp.recordedAt,
        messageCount: 12
      })
    ])
    expect(scheduled).toHaveBeenCalledWith(SCHEDULING, ['taskRecords'])
  })

  it('refuses to guess between two sessions the window cannot separate (T3)', async () => {
    const { rt, followUp } = boundState()
    const candidates = [
      sessionFor(followUp),
      sessionFor(followUp, {
        id: 'local:claude:def:/home/u/def.jsonl',
        sessionId: 'def',
        filePath: '/home/u/def.jsonl'
      })
    ]

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: deps(candidates)
    })

    const written = bindingOf(recordOf(rt.state.taskRecords))
    expect(written.gaps?.find((gap) => gap.kind === 'ambiguous_match')).toEqual({
      kind: 'ambiguous_match',
      candidateCount: 2,
      observedAt: followUp.recordedAt,
      detail: expect.stringContaining('2 sessions match this path')
    })
    // Nothing guessed: the row lists are still the synchronous empty ones.
    expect(written.runs).toEqual([])
    expect(written.sessions).toEqual([])
  })

  it('states the boundedness of a scan that found nothing', async () => {
    const { rt, followUp } = boundState()

    await completeArchiveSnapshot({ followUp, runtime: rt, scheduling: SCHEDULING, deps: deps([]) })

    const gap = bindingOf(recordOf(rt.state.taskRecords)).gaps?.find(
      (row) => row.candidateCount === 0
    )
    expect(gap?.kind).toBe('session_unattributable')
    // A bounded scan is not evidence of absence, and the stored reason says so.
    expect(gap?.detail).toContain('bounded scan')
    expect(gap?.detail).toContain('no session for this path')
  })

  it('turns a lookup failure into a gap instead of rejecting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rt, followUp } = boundState()

    await expect(
      completeArchiveSnapshot({
        followUp,
        runtime: rt,
        scheduling: SCHEDULING,
        deps: {
          sessionIndexLookup: async () => {
            throw new Error('scanner child died')
          },
          transcriptCheck: async () => ({ checkedAt: 700, presence: 'present' })
        }
      })
    ).resolves.toBeUndefined()

    const gaps = bindingOf(recordOf(rt.state.taskRecords)).gaps ?? []
    const gap = gaps.find((row) => row.detail?.includes('lookup failed'))
    expect(gap?.kind).toBe('session_unattributable')
    // The failure reason is stored, and nothing claims the lookup was still on its
    // way: the answer replaced the possibility of one (S5).
    expect(gaps.map((row) => row.detail ?? '').join('\n')).not.toMatch(/started|pending/i)
    expect(error).toHaveBeenCalled()
  })

  it('does not duplicate rows when the same enrichment runs twice', async () => {
    const { rt, followUp } = boundState()
    const args = {
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: deps([sessionFor(followUp)])
    }

    await completeArchiveSnapshot(args)
    const once = JSON.stringify(rt.state.taskRecords)
    scheduled.mockClear()

    await completeArchiveSnapshot(args)

    expect(JSON.stringify(rt.state.taskRecords)).toBe(once)
    expect(scheduled).not.toHaveBeenCalled()
  })

  it('never stores transcript content, only the path and its check', async () => {
    const { rt, followUp } = boundState()

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: deps([sessionFor(followUp)])
    })

    const serialized = JSON.stringify(rt.state.taskRecords)
    expect(serialized).not.toContain('previewMessages')
    expect(serialized).not.toContain('totalTokens')
    expect(serialized).toContain('/home/u/abc.jsonl')
  })

  it('keeps a taskRecords write that lands while the probe is in flight (S4)', async () => {
    const { rt, followUp } = boundState()
    // A settlement written between the metadata write and the enrichment's answer:
    // the same writer a second archive, the removal path or a metadata refresh uses.
    const interleaved: TaskUsageSettlement = {
      kind: 'known',
      collectedAt: 5_000,
      scope: 'worktree-rollup',
      worktreeId: ID,
      providers: [{ provider: 'claude', tokens: 1_234, costUsd: 0.2 }],
      estimatedCostUsd: 0.2
    }
    let landed = false

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: {
        sessionIndexLookup: async () => [sessionFor(followUp)],
        transcriptCheck: async () => {
          // The await window: the first version read `runtime.state.taskRecords`
          // before this point and assigned a state derived from that capture.
          const before = rt.state.taskRecords as TaskRecordsState
          const written = setTaskRecordBindingSettlement(before, {
            taskId: TASK_ID,
            worktreeId: ID,
            hostId: followUp.hostId,
            settlement: interleaved
          })
          if (!written.ok) {
            throw new Error('the fixture expects the interleaved write to apply')
          }
          rt.state.taskRecords = written.state
          landed = true
          return { checkedAt: 700, presence: 'present' }
        }
      }
    })

    expect(landed).toBe(true)
    const written = bindingOf(recordOf(rt.state.taskRecords))
    // Both survive, and the save persisted the merged state rather than the capture.
    expect(written.usageSettlement).toEqual(interleaved)
    expect(written.sessions.map((session) => session.id)).toEqual(['abc'])
    expect(written.runs?.map((run) => run.key)).toEqual(['claude|session_id:abc'])
    expect(scheduled).toHaveBeenCalledWith(SCHEDULING, ['taskRecords'])
  })

  it('leaves no "lookup started" text on an archive the lookup resolved (S5)', async () => {
    const { rt, followUp } = boundState()

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: deps([sessionFor(followUp)])
    })

    const written = bindingOf(recordOf(rt.state.taskRecords))
    expect(written.runs).toHaveLength(1)
    // A gap is retired only by an incoming gap of the same identity, so the sync
    // write may state the observation but never the progress of the lookup: this
    // archive carries no "started" row next to the rows it found.
    for (const gap of written.gaps ?? []) {
      expect(gap.detail ?? '').not.toMatch(/started|pending|in flight/i)
    }
  })

  it('copies the index resume command onto both rows, and never invents one', async () => {
    const { rt, followUp } = boundState()

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: deps([sessionFor(followUp)])
    })
    const resolved = bindingOf(recordOf(rt.state.taskRecords))
    expect(resolved.sessions[0]?.resumeCommand).toBe('claude --resume abc')
    expect(resolved.runs?.[0]?.resumeCommand).toBe('claude --resume abc')

    // The index states no command (and the hook path never has one): both rows stay
    // without it instead of this build composing a runnable-looking string.
    const silent = boundState()
    await completeArchiveSnapshot({
      followUp: silent.followUp,
      runtime: silent.rt,
      scheduling: SCHEDULING,
      deps: deps([sessionFor(silent.followUp, { resumeCommand: '' })])
    })
    const absent = bindingOf(recordOf(silent.rt.state.taskRecords))
    expect(absent.sessions[0]).not.toHaveProperty('resumeCommand')
    expect(absent.runs?.[0]).not.toHaveProperty('resumeCommand')
  })

  it('reports "nothing written" when the binding vanished while the rows were probed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rt, followUp } = boundState()
    scheduled.mockClear()

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: {
        sessionIndexLookup: async () => [sessionFor(followUp)],
        transcriptCheck: async () => {
          // The record is gone by the time the observation is applied (a profile
          // load, a reset): the write has nothing to attach to and must not report
          // a completed snapshot.
          rt.state.taskRecords = { ...(rt.state.taskRecords as TaskRecordsState), byId: {} }
          return { checkedAt: 700, presence: 'present' }
        }
      }
    })

    // Nothing was written, and no save was scheduled to persist "nothing".
    expect((rt.state.taskRecords as TaskRecordsState).byId).toEqual({})
    expect(scheduled).not.toHaveBeenCalled()
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain('wrote nothing')
  })

  it('reports "nothing written" when only a gap was left to store and the binding is gone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rt, followUp } = boundState()
    const before = rt.state.taskRecords as TaskRecordsState
    rt.state.taskRecords = { ...before, byId: {} }
    scheduled.mockClear()

    await completeArchiveSnapshot({ followUp, runtime: rt, scheduling: SCHEDULING, deps: deps([]) })

    expect((rt.state.taskRecords as TaskRecordsState).byId).toEqual({})
    expect((rt.state.taskRecords as TaskRecordsState).externalIndex).toEqual(before.externalIndex)
    expect(scheduled).not.toHaveBeenCalled()
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain('wrote nothing')
  })
})

/**
 * Follow-up 3 (review R2): the transcript check is a measurement this process can
 * take, so a **pane-attributed** archive must not stop at storing the path. These
 * tests drive the real transition (the satellite `followUp` is what
 * `applyArchiveSnapshot` actually returns), so no fixture states a job the
 * production code would not schedule.
 */
describe('archive snapshot: the transcript check', () => {
  /** A pane-attributed archive: the hook server named the session and its path, so
   *  the index scan has nothing to add and the check is the only work left. */
  function paneArchive(rows: readonly TaskRecordSession[] = [claudeSession()]) {
    const rt = runtime()
    const binding = bind(rt)
    const { state, followUp } = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: source(rows), lookup: 'pending' })
    )
    rt.state.taskRecords = state
    if (!followUp) {
      throw new Error('expected a follow-up')
    }
    return { rt, followUp, binding }
  }

  const PRESENT = {
    checkedAt: 700,
    presence: 'present' as const,
    dev: 2_049,
    ino: 8,
    mtimeMs: 300,
    size: 4_096
  }

  it('checks a pane-attributed archive without asking the session index (A3)', async () => {
    const { rt, followUp } = paneArchive()
    const lookup = vi.fn(async () => [])
    const probe = vi.fn(async () => PRESENT)

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: { sessionIndexLookup: lookup, transcriptCheck: probe }
    })

    // The pane already named the session: a scan could only restate it, and its
    // "no pane attribution" gap would contradict the rows just written.
    expect(lookup).not.toHaveBeenCalled()
    // The session row and the run row derived from it name one file: one `stat`,
    // one `checkedAt`, so both rows print the same verdict.
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith({ path: '/home/u/session-1.jsonl', hostId: 'local' })
    const written = bindingOf(recordOf(rt.state.taskRecords))
    expect(written.sessions[0].transcriptPath).toBe('/home/u/session-1.jsonl')
    expect(written.sessions[0].transcriptCheck).toEqual(PRESENT)
    expect(written.runs?.[0].transcriptCheck).toEqual(PRESENT)
    expect(scheduled).toHaveBeenCalledWith(SCHEDULING, ['taskRecords'])
    expect(scheduled).toHaveBeenCalledTimes(1)
  })

  it('leaves the path without a check when the probe fails, and saves nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rt, followUp } = paneArchive()
    const before = JSON.stringify(rt.state.taskRecords)

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: {
        sessionIndexLookup: async () => [],
        transcriptCheck: async () => {
          throw new Error('EACCES')
        }
      }
    })

    const written = bindingOf(recordOf(rt.state.taskRecords))
    // A failed measurement is not a `missing`: the path stays a fact and the reader
    // can still offer `locate trace` instead of a verdict nobody measured.
    expect(written.sessions[0].transcriptPath).toBe('/home/u/session-1.jsonl')
    expect(written.sessions[0].transcriptCheck).toBeUndefined()
    expect(written.runs?.[0].transcriptCheck).toBeUndefined()
    expect(JSON.stringify(rt.state.taskRecords)).toBe(before)
    expect(scheduled).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it('does not re-probe a stored row that already carries a check', async () => {
    const { rt, followUp } = paneArchive([checkedSession('session-1'), claudeSession('session-2')])
    const probed: string[] = []
    const probe = vi.fn(async ({ path }: { path: string }) => {
      probed.push(path)
      return PRESENT
    })

    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: { sessionIndexLookup: async () => [], transcriptCheck: probe }
    })

    expect(probed).toEqual(['/home/u/session-2.jsonl'])
    const written = bindingOf(recordOf(rt.state.taskRecords))
    const stored = (id: string) => written.sessions.find((row) => row.id === id)
    expect(stored('session-1')?.transcriptCheck).toEqual(TRANSCRIPT_CHECK)
    expect(stored('session-2')?.transcriptCheck).toEqual(PRESENT)
    // The run row of the already-measured session kept the check it was written
    // with, so the page cannot print two verdicts for one file.
    expect(
      written.runs?.find((row) => row.providerSession.id === 'session-1')?.transcriptCheck
    ).toEqual(TRANSCRIPT_CHECK)
  })

  it('schedules nothing for a second archive of an already-checked binding', async () => {
    const { rt, followUp, binding } = paneArchive()
    const probe = vi.fn(async () => PRESENT)
    await completeArchiveSnapshot({
      followUp,
      runtime: rt,
      scheduling: SCHEDULING,
      deps: { sessionIndexLookup: async () => [], transcriptCheck: probe }
    })
    expect(scheduled).toHaveBeenCalledTimes(1)
    const checked = JSON.stringify(rt.state.taskRecords)
    scheduled.mockClear()
    probe.mockClear()

    // A re-archive states the same pane rows; every stored row already carries a
    // check, so the transition decides there is nothing to follow up — no task, no
    // `stat`, and no second save of one measurement.
    const again = applied(
      archive(
        rt,
        { ...binding, isArchived: true },
        { usage: source([claudeSession()]), lookup: 'pending' }
      )
    )

    expect(again.followUp).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    expect(JSON.stringify(again.state)).toBe(checked)
  })
})
