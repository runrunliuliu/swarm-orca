import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  EMPTY_TASK_RECORDS,
  TASK_RECORDS_MAX_RUNS_PER_BINDING,
  type TaskRecordsState
} from '../../shared/task-records-types'
import {
  applyArchiveSnapshot,
  archiveLookupPlan,
  hasUnresolvedArchiveSnapshot,
  isArchiveTransition,
  runRowForSession,
  unattributableGap
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
  SCHEDULING,
  type FixtureRuntime
} from './task-records-archive-snapshot-test-fixtures'
import {
  withHookSessionFacts,
  createTaskRecordsUsageSource,
  type HookAgentStatusFacts,
  type TaskRecordsUsageSource,
  type TaskRecordsUsageStoreSet
} from './task-records-worktree-usage'
import type { TaskRecordsRuntime } from '../persistence/loading-store/task-records-persistence'
import { recordTaskRecordsForWorktreeMeta } from '../persistence/loading-store/task-records-persistence'
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

  it('records a marker gap instead of an empty authoritative list when this runtime has no source', () => {
    const rt = runtime()
    const binding = bind(rt)

    // The headless composition root (`orcad`) binds no usage source, so this is
    // where every archive in that runtime lands. It used to write nothing at all,
    // leaving `sessions: []` as the only statement — the empty history issue #31
    // reports even though the session index holds a matching session.
    const { state, followUp } = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: null })
    )

    const written = bindingOf(recordOf(state))
    expect(written.sessions).toEqual([])
    // `runs: []` says the archive write ran; the gap says it could not observe and
    // names both ways to finish the record.
    expect(written.runs).toEqual([])
    expect(written.gaps).toEqual([
      expect.objectContaining({
        kind: 'session_unattributable',
        observedAt: 600,
        detail: expect.stringContaining('no session source in this runtime')
      })
    ])
    expect(written.gaps?.[0]?.detail).toContain('orca history backfill')
    // Nothing was measured, so the figure stays absent instead of becoming a zero.
    expect(written.usageSettlement).toBeUndefined()
    // This process has no lookup either: only the marker can finish the record, by
    // an explicit backfill or by a later metadata touch in a runtime that has the
    // source. No follow-up is scheduled here.
    expect(followUp).toBeNull()
    expect(
      hasUnresolvedArchiveSnapshot({ ...written, isArchived: true })
    ).toBe(true)
  })

  it('spends the unresolved-archive marker once a session row exists', () => {
    const rt = runtime()
    const binding = bind(rt)
    // The marker is the pair (empty sessions, an unfinished-observation gap): an
    // archive that looked and found nothing also stores no rows, so the gap alone
    // cannot be the marker, and a row it did find makes the gap provenance.
    expect(
      hasUnresolvedArchiveSnapshot({
        isArchived: true,
        sessions: [],
        gaps: [unattributableGap(1, 'other_host')]
      })
    ).toBe(false)
    // An archive whose lookup never answered (the app quit, the scan was still in
    // flight) or that had no lookup at all is exactly what a later touch can
    // finish, so those texts are markers too.
    for (const plan of ['pending', 'no_lookup', 'source_unavailable'] as const) {
      expect(
        hasUnresolvedArchiveSnapshot({
          isArchived: true,
          sessions: [],
          gaps: [unattributableGap(1, plan)]
        })
      ).toBe(true)
    }
    expect(
      hasUnresolvedArchiveSnapshot({ isArchived: true, sessions: [claudeSession()] })
    ).toBe(false)
    expect(hasUnresolvedArchiveSnapshot({ isArchived: false, sessions: [] })).toBe(false)

    rt.state.taskRecords = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: null })
    ).state
    const withSource = applied(
      archive(rt, { ...binding, isArchived: true }, { usage: source([claudeSession()]), now: 900 })
    ).state
    expect(bindingOf(recordOf(withSource)).sessions).toHaveLength(1)
    expect(hasUnresolvedArchiveSnapshot(bindingOf(recordOf(withSource)))).toBe(false)
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

/**
 * Issue #31's root cause, end to end: an archive performed by a runtime with no
 * usage source used to write nothing at all, so `sessions: []` was the record's
 * only statement — and the page printed it as "never ran" even when the local
 * session index held the workspace's session. The writer now stores an explicit
 * `source_unavailable` gap (the marker); the **next metadata touch** of that
 * binding, in a runtime that does have the source, is the moment the snapshot is
 * finished. There is no automatic startup scan: the touch is an operator action.
 */
describe('archive snapshot: the recoverable marker (issue #31)', () => {
  const WT = (suffix: string): string => `repo-1::/repo/${suffix}`
  const pathOf = (worktreeId: string): string => worktreeId.slice(worktreeId.indexOf('::') + 2)

  function context(rt: FixtureRuntime) {
    return { runtime: rt as unknown as TaskRecordsRuntime, scheduling: SCHEDULING }
  }

  function bindingFor(rt: FixtureRuntime, worktreeId: string) {
    const record = recordOf(rt.state.taskRecords)
    const binding = record.bindings.find((entry) => entry.worktreeId === worktreeId)
    if (!binding) {
      throw new Error(`the fixture expects a binding for ${worktreeId}`)
    }
    return binding
  }

  /** A session dated inside the binding's own window (`boundAt` is the real
   *  write-path clock, so a fixed calendar instant would fall before its edge).
   *  `createdAt` sits just *before* the window: a session that starts after the
   *  touch instant would be filtered out by `recordedAt`. */
  function sessionInWindow(worktreeId: string, boundAt: number) {
    return indexSession({
      cwd: pathOf(worktreeId),
      createdAt: new Date(boundAt - 1_000).toISOString(),
      updatedAt: new Date(boundAt).toISOString(),
      modifiedAt: new Date(boundAt).toISOString()
    })
  }

  function sourceWithIndex(args: {
    index: readonly AiVaultSession[]
    lookup?: () => Promise<readonly AiVaultSession[]>
  }): TaskRecordsUsageSource {
    return {
      ...source([]),
      archiveSnapshot: {
        sessionIndexLookup: args.lookup ?? (async () => args.index),
        transcriptCheck: async () => ({ checkedAt: 700, presence: 'present' })
      }
    }
  }

  function archiveWithoutSource(rt: FixtureRuntime, worktreeId: string) {
    recordTaskRecordsForWorktree(context(rt), worktreeId, meta())
    recordTaskRecordsForWorktree(context(rt), worktreeId, meta({ isArchived: true }))
    return bindingFor(rt, worktreeId)
  }

  it('finishes the record from an index hit on the next metadata touch', async () => {
    const rt = runtime()
    const worktreeId = WT('feature-index-hit')
    const marked = archiveWithoutSource(rt, worktreeId)
    // The precondition the page used to read as "never ran".
    expect(marked.sessions).toEqual([])
    expect(hasUnresolvedArchiveSnapshot(marked)).toBe(true)
    scheduled.mockClear()

    // A runtime that has the source (the desktop composition root), and an
    // ordinary metadata touch — not an archive transition, and no startup scan.
    const lookup = vi.fn(async () => [sessionInWindow(worktreeId, marked.boundAt)])
    rt.taskRecordsUsageSource = sourceWithIndex({ index: [], lookup })
    recordTaskRecordsForWorktree(context(rt), worktreeId, {
      ...meta({ isArchived: true }),
      isUnread: true
    })

    await vi.waitFor(() => expect(bindingFor(rt, worktreeId).sessions).toHaveLength(1))
    const finished = bindingFor(rt, worktreeId)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(finished.sessions[0]).toMatchObject({
      provider: 'claude',
      key: 'session_id',
      id: 'abc',
      source: 'archive-snapshot'
    })
    expect(finished.runs?.[0]).toMatchObject({
      key: 'claude|session_id:abc',
      source: 'archive-snapshot'
    })
    // The marker gap stays as provenance — the archive moment really could not
    // see — and it is no longer the standalone state, because rows exist now.
    expect(finished.gaps?.map((gap) => gap.kind)).toContain('session_unattributable')
    expect(hasUnresolvedArchiveSnapshot(finished)).toBe(false)
    expect(scheduled).toHaveBeenCalledWith(SCHEDULING, ['taskRecords'])
  })

  it('finishes a "lookup never answered" archive (app exit) on the next touch', async () => {
    const rt = runtime()
    const worktreeId = WT('feature-pending')
    // Bind with no source, then archive while the source exists but no save target
    // does: the plan is `no_lookup`, so the sync write stores `runs: []` and a gap
    // that names the lookup as the remaining source, and nothing is scheduled —
    // exactly what a quit / a still-running scan leaves behind.
    recordTaskRecordsForWorktree(context(rt), worktreeId, meta())
    rt.taskRecordsUsageSource = sourceWithIndex({ index: [] })
    recordTaskRecordsForWorktreeMeta(rt, worktreeId, meta({ isArchived: true }), null)

    const pendingBinding = bindingFor(rt, worktreeId)
    expect(pendingBinding.sessions).toEqual([])
    expect(pendingBinding.runs).toEqual([])
    expect(pendingBinding.gaps?.map((gap) => gap.detail ?? '')).toContainEqual(
      expect.stringContaining('no session index lookup is available')
    )
    expect(hasUnresolvedArchiveSnapshot(pendingBinding)).toBe(true)

    // The next metadata touch, in a runtime that can persist the lookup, finishes it.
    rt.taskRecordsUsageSource = sourceWithIndex({
      index: [sessionInWindow(worktreeId, pendingBinding.boundAt)]
    })
    recordTaskRecordsForWorktree(context(rt), worktreeId, {
      ...meta({ isArchived: true }),
      isPinned: true
    })

    await vi.waitFor(() => expect(bindingFor(rt, worktreeId).sessions).toHaveLength(1))
    expect(hasUnresolvedArchiveSnapshot(bindingFor(rt, worktreeId))).toBe(false)
  })

  it('records the bounded-scan gap on an index miss and tries once per process', async () => {
    const rt = runtime()
    const worktreeId = WT('feature-index-miss')
    const marked = archiveWithoutSource(rt, worktreeId)
    expect(hasUnresolvedArchiveSnapshot(marked)).toBe(true)
    const lookup = vi.fn(async () => [])
    rt.taskRecordsUsageSource = sourceWithIndex({ index: [], lookup })

    recordTaskRecordsForWorktree(context(rt), worktreeId, {
      ...meta({ isArchived: true }),
      isUnread: true
    })
    await vi.waitFor(() =>
      expect(
        bindingFor(rt, worktreeId).gaps?.some((gap) => gap.detail?.includes('bounded scan'))
      ).toBe(true)
    )

    const missed = bindingFor(rt, worktreeId)
    // Nothing invented: still no rows, and the absence states the scan was bounded.
    expect(missed.sessions).toEqual([])
    expect(missed.runs).toEqual([])
    expect(missed.gaps?.map((gap) => gap.detail ?? '')).toContainEqual(
      expect.stringContaining('no session for this path')
    )
    // The marker survives, so another process (or `orca history backfill`) can try
    // again — but this process does not rescan on every later touch of the row.
    expect(hasUnresolvedArchiveSnapshot(missed)).toBe(true)
    recordTaskRecordsForWorktree(context(rt), worktreeId, {
      ...meta({ isArchived: true }),
      isPinned: true
    })
    await Promise.resolve()
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('writes no second row and no second save when the same touch is replayed', async () => {
    const rt = runtime()
    const worktreeId = WT('feature-idempotent')
    const marked = archiveWithoutSource(rt, worktreeId)
    rt.taskRecordsUsageSource = sourceWithIndex({
      index: [sessionInWindow(worktreeId, marked.boundAt)]
    })
    const edit = { ...meta({ isArchived: true }), isUnread: true }
    recordTaskRecordsForWorktree(context(rt), worktreeId, edit)
    await vi.waitFor(() => expect(bindingFor(rt, worktreeId).sessions).toHaveLength(1))
    const once = JSON.stringify(rt.state.taskRecords)
    scheduled.mockClear()

    recordTaskRecordsForWorktree(context(rt), worktreeId, edit)
    await Promise.resolve()

    expect(JSON.stringify(rt.state.taskRecords)).toBe(once)
    expect(bindingFor(rt, worktreeId).sessions).toHaveLength(1)
    expect(bindingFor(rt, worktreeId).runs).toHaveLength(1)
    expect(scheduled).not.toHaveBeenCalled()
  })

  it('keeps the marker and stores the failure gap when the lookup throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rt = runtime()
    const worktreeId = WT('feature-index-failure')
    archiveWithoutSource(rt, worktreeId)
    rt.taskRecordsUsageSource = sourceWithIndex({
      index: [],
      lookup: async () => {
        throw new Error('scanner child died')
      }
    })

    expect(() =>
      recordTaskRecordsForWorktree(context(rt), worktreeId, {
        ...meta({ isArchived: true }),
        isUnread: true
      })
    ).not.toThrow()
    await vi.waitFor(() =>
      expect(
        bindingFor(rt, worktreeId).gaps?.some((gap) => gap.detail?.includes('lookup failed'))
      ).toBe(true)
    )

    const failed = bindingFor(rt, worktreeId)
    // A failure to look is not a proof of absence, and it never escapes into the
    // metadata write that fired it.
    expect(failed.sessions).toEqual([])
    expect(failed.gaps?.every((gap) => gap.kind === 'session_unattributable')).toBe(true)
    expect(hasUnresolvedArchiveSnapshot(failed)).toBe(true)
    expect(error).toHaveBeenCalled()
  })
})
