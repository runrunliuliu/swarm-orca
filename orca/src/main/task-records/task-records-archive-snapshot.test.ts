import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_TASK_RECORDS,
  TASK_RECORDS_MAX_RUNS_PER_BINDING,
  type TaskRecordsState
} from '../../shared/task-records-types'
import {
  applyArchiveSnapshot,
  archiveLookupPlan,
  isArchiveTransition,
  runRowForSession
} from './task-records-archive-snapshot'
import { createTranscriptCheckProbe } from './task-records-transcript-check'
import { selectSessionIndexCandidate } from './task-records-session-index-lookup'
import {
  checkedSession,
  claudeSession,
  settlement,
  source,
  runtime,
  recordOf,
  bindingOf,
  bind,
  archive,
  applied,
  indexSession,
  meta,
  ID,
  TASK_ID,
  SCHEDULING
} from './task-records-archive-snapshot-test-fixtures'
import {
  withHookSessionFacts,
  createTaskRecordsUsageSource,
  type HookAgentStatusFacts,
  type TaskRecordsUsageSource,
  type TaskRecordsUsageStoreSet
} from './task-records-worktree-usage'
import type { TaskRecordsRuntime } from '../persistence/loading-store/task-records-persistence'
import { recordTaskRecordsForWorktree } from '../persistence/loading-store/task-records-metadata-hooks'

const scheduled = vi.hoisted(() => vi.fn())
vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: scheduled }))

afterEach(() => {
  scheduled.mockClear()
  vi.restoreAllMocks()
})

describe('archive snapshot: the transition', () => {
  it('fires only on false → true, including a workspace that had no binding yet', () => {
    // No prior binding: the metadata write binds the workspace and the snapshot
    // belongs to that same write.
    expect(isArchiveTransition(undefined, { isArchived: true })).toBe(true)
    expect(isArchiveTransition(undefined, { isArchived: false })).toBe(false)
    expect(isArchiveTransition({ isArchived: false }, { isArchived: true })).toBe(true)
    // An archive of an already-archived row is not a second irreversible moment.
    expect(isArchiveTransition({ isArchived: true }, { isArchived: true })).toBe(false)
    // Unarchiving is never a snapshot.
    expect(isArchiveTransition({ isArchived: true }, { isArchived: false })).toBe(false)
  })

  it('writes sessions, one run per claim and the removal-style settlement in one transition', () => {
    const rt = runtime()
    const binding = bind(rt)
    const { state } = applied(archive(rt, { ...binding, isArchived: true }))

    const written = bindingOf(recordOf(state))
    expect(written.sessions).toEqual([
      expect.objectContaining({
        provider: 'claude',
        id: 'session-1',
        source: 'archive-snapshot',
        recordedAt: 600
      })
    ])
    expect(written.runs).toEqual([
      expect.objectContaining({
        key: 'claude|session_id:session-1',
        providerSession: { provider: 'claude', key: 'session_id', id: 'session-1' },
        source: 'archive-snapshot',
        recordedAt: 600
      })
    ])
    expect(written.usageSettlement).toEqual(settlement(500))
    // A snapshot that attributed something needs no gap.
    expect(written.gaps).toBeUndefined()
  })

  it('stores only record facts, never the renderer agent rows', () => {
    const rt = runtime()
    const binding = bind(rt)
    const { state } = applied(archive(rt, { ...binding, isArchived: true }))

    expect(Object.keys(bindingOf(recordOf(state))).sort()).toEqual([
      'boundAt',
      'boundBy',
      'hostId',
      'isArchived',
      'lastVerifiedAt',
      'path',
      'repoId',
      'resolvedVia',
      'runs',
      'sessions',
      'usageSettlement',
      'worktreeId'
    ])
  })

  it('refuses a snapshot over the run cap instead of truncating it (A4)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rt = runtime()
    const binding = bind(rt)
    const before = rt.state.taskRecords as TaskRecordsState
    const rows = Array.from({ length: TASK_RECORDS_MAX_RUNS_PER_BINDING + 1 }, (_, index) =>
      claudeSession(`session-${index}`)
    )

    const outcome = archive(rt, { ...binding, isArchived: true }, { usage: source(rows) })

    expect(outcome).toEqual({ kind: 'refused', reason: 'limit' })
    // No partial write: sessions, runs, gaps and settlement are all untouched.
    expect(before.byId[TASK_ID].bindings[0]).toEqual(binding)
    expect(error).toHaveBeenCalled()
  })

  it('writes an explicit gap, not an empty authoritative list, when nothing is attributable (T2)', () => {
    const rt = runtime()
    const binding = bind(rt)
    const { state } = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: source([]), lookup: 'pending' })
    )

    const written = bindingOf(recordOf(state))
    // `runs: []` says the writer looked; the gap says why it has no rows. A reader
    // must never render zero rows without it as "never ran".
    expect(written.runs).toEqual([])
    expect(written.gaps).toEqual([
      {
        kind: 'session_unattributable',
        observedAt: 600,
        detail:
          'no pane attribution from the hook server at the archive moment; the session index lookup by path is the remaining source'
      }
    ])
    // The gap states the observation, never the progress of the lookup that is
    // about to run: gap identity is `kind|detail`, so a "lookup started" row could
    // not be retired by the answer it describes (S5).
    expect(written.gaps?.[0]?.detail ?? '').not.toMatch(/started|pending/i)
    // `candidateCount` is absent because nothing was counted yet — `0` would be a
    // measured "looked and found none".
    expect(written.gaps?.[0]).not.toHaveProperty('candidateCount')
  })

  it.each([
    ['no_lookup' as const, 'no session index lookup is available'],
    ['other_host' as const, 'belongs to another host']
  ])('records why no lookup can ever follow up (%s)', (lookup, expected) => {
    const rt = runtime()
    const binding = bind(rt)
    const { state, followUp } = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: source([]), lookup })
    )

    const gap = bindingOf(recordOf(state)).gaps?.[0]
    expect(gap?.kind).toBe('session_unattributable')
    expect(gap?.detail).toContain(expected)
    expect(followUp).toBeNull()
  })

  it('asks only for a check when the pane side already attributed the rows', () => {
    const rt = runtime()
    const binding = bind(rt)

    const { state, followUp } = applied(
      archive(
        rt,
        { ...binding, isArchived: true },
        { usage: source([claudeSession()]), lookup: 'pending' }
      )
    )

    // The scan has nothing to add (a pane already named the session) but the file
    // is still unmeasured: the metadata write is synchronous, so taking the check
    // is the follow-up's job and only that job is scheduled.
    expect(followUp).toEqual({
      taskId: TASK_ID,
      worktreeId: ID,
      hostId: binding.hostId,
      path: binding.path,
      recordedAt: 600,
      windowStart: binding.boundAt,
      lookup: false,
      check: true
    })
    const written = bindingOf(recordOf(state))
    expect(written.sessions[0].transcriptPath).toBe('/home/u/session-1.jsonl')
    expect(written.sessions[0].transcriptCheck).toBeUndefined()
  })

  it('schedules no follow-up when the attributed row already carries a check', () => {
    const rt = runtime()
    const binding = bind(rt)

    const { followUp } = applied(
      archive(
        rt,
        { ...binding, isArchived: true },
        { usage: source([checkedSession()]), lookup: 'pending' }
      )
    )

    // Nothing to look up and nothing to measure: no task, and so no second save.
    expect(followUp).toBeNull()
  })

  it('claims nothing at all before a usage source is bound', () => {
    const rt = runtime()
    const binding = bind(rt)

    // A startup-order gap is not the workspace's absence to explain.
    expect(archive(rt, { ...binding, isArchived: true }, { usage: null })).toEqual({
      kind: 'skipped',
      reason: 'no_source'
    })
  })

  it('reports "nothing written" instead of a snapshot when the record is gone (refusal shape)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rt = runtime()
    const binding = bind(rt)

    // The retry shape seat C hits: a selection made against a state that no longer
    // holds the record. The transition answers `{ ok: true, changed: false, skipped:
    // 'missing_binding' }`, which is a write that happened nowhere — not a snapshot.
    const outcome = applyArchiveSnapshot({
      state: EMPTY_TASK_RECORDS,
      taskId: TASK_ID,
      binding: { ...binding, isArchived: true },
      usageSource: source([claudeSession()]),
      lookup: 'no_lookup',
      now: 600
    })

    expect(outcome).toEqual({ kind: 'refused', reason: 'missing_binding' })
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain('wrote nothing')
  })

  it('keeps a measured settlement on a re-archive and says the figure was not written', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rt = runtime()
    const binding = bind(rt)
    rt.state.taskRecords = applied(archive(rt, { ...binding, isArchived: true })).state

    // Archive → unarchive → archive, with the usage store disabled the second time:
    // an `unavailable` snapshot never replaces the measured figure (seat A's N4 rule).
    const unmeasured: TaskRecordsUsageSource = {
      captureSessionsForRemoval: () => {},
      snapshotForRemoval: () => ({
        settlement: {
          kind: 'unavailable' as const,
          collectedAt: 800,
          scope: 'worktree-rollup' as const,
          worktreeId: ID,
          reason: 'usage_not_enabled' as const
        },
        sessions: [claudeSession('session-2')]
      })
    }
    const second = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: unmeasured, now: 800 })
    )

    const written = bindingOf(recordOf(second.state))
    // The figure stands with its own `collectedAt`, and the rows of this snapshot
    // are still written: one skipped figure is not a reason to drop the snapshot.
    expect(written.usageSettlement).toEqual(settlement(500))
    expect(written.sessions.map((session) => session.id)).toEqual(['session-1', 'session-2'])
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'wrote no settlement'
    )
  })

  it('never throws into the metadata write when the source fails', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing: TaskRecordsUsageSource = {
      captureSessionsForRemoval: () => {},
      snapshotForRemoval: () => {
        throw new Error('scan unavailable')
      }
    }
    const rt = runtime()
    const binding = bind(rt)

    expect(archive(rt, { ...binding, isArchived: true }, { usage: failing })).toEqual({
      kind: 'refused',
      reason: 'source_failed'
    })
    expect(error).toHaveBeenCalled()
  })

  it('plans a lookup only for a local owner that has both a lookup and a scheduling', () => {
    expect(archiveLookupPlan({ hostId: 'local', hasLookup: true, hasScheduling: true })).toBe(
      'pending'
    )
    expect(archiveLookupPlan({ hostId: 'ssh:box', hasLookup: true, hasScheduling: true })).toBe(
      'other_host'
    )
    expect(archiveLookupPlan({ hostId: 'local', hasLookup: false, hasScheduling: true })).toBe(
      'no_lookup'
    )
    expect(archiveLookupPlan({ hostId: 'local', hasLookup: true, hasScheduling: false })).toBe(
      'no_lookup'
    )
  })
})

describe('session index: the candidate rule', () => {
  it('matches the path exactly, not the prefix the scope filter accepts', () => {
    const selection = selectSessionIndexCandidate(
      [
        indexSession(),
        // Same parent, different workspace: the bucket prefix `scopePaths` uses
        // would let this through, the exact comparison must not.
        indexSession({ id: 'other', sessionId: 'other', cwd: '/repo/feature-2' })
      ],
      { path: '/repo/feature', windowStart: 0, windowEnd: Date.now() }
    )
    expect(selection.kind).toBe('unique')
  })

  it('drops a session whose observed end predates the window', () => {
    const selection = selectSessionIndexCandidate([indexSession()], {
      path: '/repo/feature',
      // The session ended an hour ago; a window that opens now cannot see it.
      windowStart: Date.now(),
      windowEnd: Date.now()
    })
    expect(selection).toEqual({ kind: 'none' })
  })

  it('keeps a session the index cannot date, because dropping it would be unproven', () => {
    const selection = selectSessionIndexCandidate(
      [indexSession({ createdAt: null, updatedAt: null, modifiedAt: 'not-a-date' })],
      { path: '/repo/feature', windowStart: 1, windowEnd: 2 }
    )
    expect(selection.kind).toBe('unique')
  })

  it('ignores a session whose cwd the index does not know', () => {
    const selection = selectSessionIndexCandidate([indexSession({ cwd: null })], {
      path: '/repo/feature',
      windowStart: 0,
      windowEnd: 10
    })
    expect(selection).toEqual({ kind: 'none' })
  })
})

describe('transcript check', () => {
  const probe = createTranscriptCheckProbe(() => 900)

  it('records dev/ino/mtime/size of an existing transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-transcript-'))
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, 'not stored, only measured')

    const check = await probe({ path: file, hostId: 'local' })

    expect(check.presence).toBe('present')
    expect(check.size).toBe(25)
    expect(check.mtimeMs).toBeGreaterThan(0)
    expect(typeof check.dev).toBe('number')
    expect(typeof check.ino).toBe('number')
    expect(check.checkedAt).toBe(900)
  })

  it('proves `missing` only from a local ENOENT', async () => {
    const check = await probe({
      path: join(tmpdir(), 'orca-transcript-does-not-exist.jsonl'),
      hostId: 'local'
    })
    expect(check).toEqual({ checkedAt: 900, presence: 'missing' })
  })

  it('reports `unverifiable` for a path this host cannot look at', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-transcript-'))
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')

    // ENOTDIR: the path cannot be stat'ed, which is not a proof of absence.
    const notADirectory = await probe({ path: join(file, 'session.jsonl'), hostId: 'local' })
    expect(notADirectory.presence).toBe('unverifiable')

    // A remote owner's transcripts are not on this disk at all.
    const remote = await probe({ path: '/home/u/abc.jsonl', hostId: 'ssh:box' })
    expect(remote).toEqual({ checkedAt: 900, presence: 'unverifiable' })
  })
})

describe('the metadata seam', () => {
  it('writes one taskRecords-only save through the hook both metadata entry points call', () => {
    // Both the renderer's `worktrees:updateMeta` and the RPC/CLI `worktree.set`
    // reach `recordTaskRecordsForWorktree`, which is this seam; driving the seam
    // directly keeps the assertion independent of either transport.
    const rt = runtime()
    rt.taskRecordsUsageSource = source([claudeSession()])
    const context = { runtime: rt as unknown as TaskRecordsRuntime, scheduling: SCHEDULING }
    recordTaskRecordsForWorktree(context, ID, meta())
    scheduled.mockClear()

    recordTaskRecordsForWorktree(context, ID, meta({ isArchived: true }))

    // One save, of the task ledger only: the archive touches nothing else.
    expect(scheduled).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveBeenCalledWith(SCHEDULING, ['taskRecords'])
    expect(bindingOf(recordOf(rt.state.taskRecords)).runs).toHaveLength(1)
  })

  it('leaves every non-taskRecords field of the state byte-identical (A5)', () => {
    // The derived projection a renderer builds (active workspaces, needs-you, the
    // default workspace, badges and live counts) is read from `worktreeMeta`, the
    // session partitions and the status rows — none of which the snapshot writes.
    // Comparing the whole state minus `taskRecords` is the mechanical form of that
    // claim, so a later edit that sneaks a derived field in fails here.
    const rt = runtime({
      worktreeMeta: {
        [ID]: meta(),
        'repo-1::/repo/other': meta({ displayName: 'Other' })
      },
      workspaceSession: { local: { tabsByWorktree: { [ID]: [] } } },
      settings: { defaultWorktreeId: ID, taskViewPreset: 'all' },
      agentStatus: { 'tab-1:leaf': { state: 'done', worktreeId: ID } },
      needsYou: [ID],
      badges: { 'repo-1': 2 }
    })
    const context = { runtime: rt as unknown as TaskRecordsRuntime, scheduling: SCHEDULING }
    recordTaskRecordsForWorktree(context, ID, meta())
    rt.taskRecordsUsageSource = source([claudeSession()])
    const project = (): string => JSON.stringify({ ...rt.state, taskRecords: undefined })
    const before = project()
    scheduled.mockClear()

    recordTaskRecordsForWorktree(context, ID, meta({ isArchived: true }))

    expect(project()).toBe(before)
    expect(scheduled).toHaveBeenCalledWith(SCHEDULING, ['taskRecords'])
  })
})

describe('run rows', () => {
  it('maps a session claim to a run claim without inventing an outcome', () => {
    const run = runRowForSession(
      { provider: 'claude', key: 'session_id', id: 'abc', firstSeenAt: 1, lastSeenAt: 2 },
      700
    )
    expect(run.key).toBe('claude|session_id:abc')
    expect(run.source).toBe('archive-snapshot')
    expect(run).not.toHaveProperty('outcome')
    expect(run).not.toHaveProperty('startedAt')
    // The hook path observes a pane, not a session index row, so it has no resume
    // command to copy: absent, not composed.
    expect(run).not.toHaveProperty('resumeCommand')
  })
})

/**
 * Issue #53 review facts: the turn verdict. The run row can carry it (seat A's
 * `outcome`), so the mapping has to come from the one place that states it — the
 * hook status row for the session's pane — through the real join and the real
 * source, never from a fixture that assumes the answer.
 */
describe('run outcome', () => {
  const noStores: TaskRecordsUsageStoreSet = {
    claude: {
      getScanState: () => ({ enabled: false }),
      getSnapshot: () => ({ projectBreakdown: [] })
    },
    codex: {
      getScanState: () => ({ enabled: false }),
      getSnapshot: () => ({ projectBreakdown: [] })
    },
    opencode: {
      getScanState: () => ({ enabled: false }),
      getSnapshot: () => ({ projectBreakdown: [] })
    },
    muse: {
      getScanState: () => ({ enabled: false }),
      getSnapshot: () => ({ projectBreakdown: [] })
    }
  }

  /** The whole chain under test: one pane row → the join → the source → the run row. */
  function hookSource(row: HookAgentStatusFacts | undefined): TaskRecordsUsageSource {
    return createTaskRecordsUsageSource({
      stores: noStores,
      sessionIdentities: () =>
        withHookSessionFacts(
          [{ paneKey: 'tab-1:leaf', sessionId: 'session-1', key: 'session_id', worktreeId: ID }],
          row === undefined ? [] : [row]
        ),
      providerForPaneKey: () => 'claude'
    })
  }

  const failure = hookSource({
    paneKey: 'tab-1:leaf',
    state: 'done',
    stateStartedAt: 200,
    mainAgent: { state: 'done', outcome: 'failure' }
  })

  it('stores the verdict the hook status stated for the session pane', () => {
    const rt = runtime()
    const binding = bind(rt)
    const { state } = applied(archive(rt, { ...binding, isArchived: true }, { usage: failure }))

    expect(bindingOf(recordOf(state)).runs).toEqual([
      expect.objectContaining({ key: 'claude|session_id:session-1', outcome: 'failure' })
    ])
  })

  it('leaves the outcome absent for a plain Stop instead of calling it a success', () => {
    const rt = runtime()
    const binding = bind(rt)
    const { state } = applied(
      archive(
        rt,
        { ...binding, isArchived: true },
        {
          usage: hookSource({ paneKey: 'tab-1:leaf', state: 'done', stateStartedAt: 200 })
        }
      )
    )

    const run = bindingOf(recordOf(state)).runs?.[0]
    // The row exists (the session was observed) and states no verdict: unknown is
    // the honest value, and it is not `success`.
    expect(run?.key).toBe('claude|session_id:session-1')
    expect(run).not.toHaveProperty('outcome')
  })

  it('does not overwrite a stored verdict with an absent one on replay', () => {
    const rt = runtime()
    const binding = bind(rt)
    rt.state.taskRecords = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: failure })
    ).state

    // A later observation of the same claim that states no verdict — the pane is
    // gone, or the turn ended in a plain Stop. Not knowing a verdict now is not
    // evidence that the stored one was wrong (seat A's "absent never erases").
    const replayed = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: hookSource(undefined), now: 900 })
    )

    expect(bindingOf(recordOf(replayed.state)).runs?.[0]?.outcome).toBe('failure')
  })
})
