import { describe, expect, it } from 'vitest'
import { normalizeTaskRecords } from './task-records-normalize'
import {
  mergeTaskRecordBindingSessions,
  mergeTaskRecordRuns,
  upsertTaskRecordBinding
} from './task-records-updates'
import {
  EMPTY_TASK_RECORDS,
  TASK_RECORD_SCHEMA_VERSION,
  TASK_RECORDS_MAX_RUNS_PER_BINDING,
  taskRecordRunClaimKey,
  type TaskRecord,
  type TaskRecordRun,
  type TaskRecordSession,
  type TaskRecordsState
} from './task-records-types'

const TASK_ID = 'task:github:repo-1:issue:31'
const WORKTREE_ID = 'repo-1::/repo/feature'

function bound(): TaskRecordsState {
  const result = upsertTaskRecordBinding(EMPTY_TASK_RECORDS, {
    taskId: TASK_ID,
    hostId: 'local',
    repoId: 'repo-1',
    worktreeId: WORKTREE_ID,
    path: '/repo/feature',
    isArchived: true,
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    now: 100
  })
  if (!result.ok) {
    throw new Error('fixture binding refused')
  }
  return result.state
}

const CLAIM = { provider: 'claude' as const, key: 'session_id', id: 'abc' }

function run(overrides: Partial<TaskRecordRun> = {}): TaskRecordRun {
  return {
    key: taskRecordRunClaimKey(CLAIM),
    providerSession: { ...CLAIM },
    title: 'Resume the trace',
    agentType: 'claude',
    startedAt: 1_000,
    endedAt: 2_000,
    messageCount: 12,
    outcome: 'success',
    transcriptPath: '/home/u/abc.jsonl',
    source: 'archive-snapshot',
    recordedAt: 2_100,
    firstSeenAt: 2_100,
    lastSeenAt: 2_100,
    ...overrides
  }
}

function runsOf(state: TaskRecordsState): TaskRecordRun[] {
  const runs = state.byId[TASK_ID].bindings[0].runs
  if (!runs) {
    throw new Error('binding carries no runs')
  }
  return runs
}

/** A stored row with fields this build would not write itself (a hand edit, or
 *  another build's leftover): deliberately untyped so a test can spell the dirty
 *  durable it wants the load boundary to reject. */
function dirtyRow(overrides: Record<string, unknown> = {}): unknown {
  return { ...run(), ...overrides }
}

function merge(state: TaskRecordsState, runs: TaskRecordRun[], now = 2_100) {
  return mergeTaskRecordRuns(state, {
    taskId: TASK_ID,
    worktreeId: WORKTREE_ID,
    hostId: 'local',
    runs,
    now
  })
}

describe('mergeTaskRecordRuns', () => {
  it('stores one run per claim and treats an identical replay as no change', () => {
    const first = merge(bound(), [run()])
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(first.changed).toBe(true)
    expect(runsOf(first.state)).toEqual([run()])
    expect(first.state.byId[TASK_ID].schemaVersion).toBe(TASK_RECORD_SCHEMA_VERSION)

    const replay = merge(first.state, [run()])
    expect(replay.ok).toBe(true)
    if (!replay.ok) {
      return
    }
    // A6 depends on this: replaying the same observation must not append a row,
    // must not rewrite provenance, and must not look like a ledger write.
    expect(replay.changed).toBe(false)
    expect(replay.state).toBe(first.state)
  })

  it('merges a later observation into the same row and unions the observation window', () => {
    const first = merge(bound(), [run()])
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const later = merge(
      first.state,
      [
        run({
          title: 'Resume the trace (final)',
          endedAt: 2_500,
          messageCount: 30,
          source: 'backfill',
          recordedAt: 3_000,
          firstSeenAt: 900,
          lastSeenAt: 3_000
        })
      ],
      3_000
    )
    expect(later.ok).toBe(true)
    if (!later.ok) {
      return
    }
    expect(runsOf(later.state)).toHaveLength(1)
    expect(runsOf(later.state)[0]).toMatchObject({
      title: 'Resume the trace (final)',
      startedAt: 1_000,
      endedAt: 2_500,
      messageCount: 30,
      // Union of the two observations, not last-write-wins.
      firstSeenAt: 900,
      lastSeenAt: 3_000,
      // Provenance is first-writer-wins: a later backfill may not relabel a row
      // that was frozen at the archive moment as a reconstruction.
      source: 'archive-snapshot',
      recordedAt: 2_100
    })
  })

  it('keeps a measured fact when a later observation cannot state it', () => {
    const first = merge(bound(), [run()])
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const blind: TaskRecordRun = {
      key: taskRecordRunClaimKey(CLAIM),
      providerSession: { ...CLAIM },
      source: 'backfill',
      recordedAt: 4_000,
      firstSeenAt: 4_000,
      lastSeenAt: 4_000
    }
    const second = merge(first.state, [blind], 4_000)
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    expect(runsOf(second.state)[0]).toMatchObject({
      title: 'Resume the trace',
      startedAt: 1_000,
      endedAt: 2_000,
      messageCount: 12,
      outcome: 'success',
      transcriptPath: '/home/u/abc.jsonl',
      lastSeenAt: 4_000
    })
  })

  it('keeps one row for two providers claiming the same id', () => {
    const first = merge(bound(), [run()])
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const otherProvider = run({
      key: taskRecordRunClaimKey({ provider: 'codex', key: 'conversation_id', id: 'abc' }),
      providerSession: { provider: 'codex', key: 'conversation_id', id: 'abc' }
    })
    const second = merge(first.state, [otherProvider])
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    // Two claims, not a duplicate to collapse and not a conflict to hide.
    expect(runsOf(second.state)).toHaveLength(2)
  })

  it('refuses the run past the per-binding cap and leaves the stored state alone', () => {
    const full = Array.from({ length: TASK_RECORDS_MAX_RUNS_PER_BINDING }, (_, index) =>
      run({
        key: taskRecordRunClaimKey({ provider: 'claude', key: 'session_id', id: `s${index}` }),
        providerSession: { provider: 'claude', key: 'session_id', id: `s${index}` }
      })
    )
    const first = merge(bound(), full)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(runsOf(first.state)).toHaveLength(TASK_RECORDS_MAX_RUNS_PER_BINDING)

    const oneTooMany = merge(first.state, [
      run({
        key: taskRecordRunClaimKey({ provider: 'claude', key: 'session_id', id: 'overflow' }),
        providerSession: { provider: 'claude', key: 'session_id', id: 'overflow' }
      })
    ])
    // A refusal is a value, never a truncation: the caller reports it and the
    // stored state keeps exactly what it had.
    expect(oneTooMany).toEqual({ ok: false, reason: 'limit' })
    expect(runsOf(first.state)).toHaveLength(TASK_RECORDS_MAX_RUNS_PER_BINDING)

    // A row already stored may still be updated at the cap: only growth is refused.
    const refresh = merge(first.state, [full[0]])
    expect(refresh).toMatchObject({ ok: true, changed: false })
  })

  it('records a binding-level gap once, however often it is observed', () => {
    const gap = {
      kind: 'session_unattributable' as const,
      candidateCount: 0,
      observedAt: 2_100,
      detail: 'no pane ownership and no index hit'
    }
    const first = mergeTaskRecordRuns(bound(), {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      runs: [],
      gaps: [gap],
      now: 2_100
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(first.state.byId[TASK_ID].bindings[0].gaps).toEqual([gap])

    const replay = mergeTaskRecordRuns(first.state, {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      runs: [],
      gaps: [{ ...gap, observedAt: 5_000 }],
      now: 5_000
    })
    expect(replay).toMatchObject({ ok: true, changed: false })
  })
})

const CHECK = {
  checkedAt: 2_100,
  presence: 'present' as const,
  dev: 6_636,
  ino: 42,
  mtimeMs: 1_700,
  size: 900
}

describe('transcript check (issue #53: paths and check values, never content)', () => {
  it('round-trips the check values on a run and on a session', () => {
    const observation = run({ transcriptCheck: CHECK })
    const withRun = merge(bound(), [observation])
    expect(withRun.ok).toBe(true)
    if (!withRun.ok) {
      return
    }
    const withSession = mergeTaskRecordBindingSessions(withRun.state, {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      sessions: [
        {
          provider: 'claude',
          key: 'session_id',
          id: 'abc',
          transcriptPath: '/home/u/abc.jsonl',
          source: 'archive-snapshot',
          recordedAt: 2_100,
          transcriptCheck: CHECK,
          firstSeenAt: 2_100,
          lastSeenAt: 2_100
        }
      ],
      now: 2_100
    })
    expect(withSession.ok).toBe(true)
    if (!withSession.ok) {
      return
    }

    const reread = normalizeTaskRecords(JSON.parse(JSON.stringify(withSession.state)))
    expect(reread.discarded).toEqual({
      sessions: 0,
      runs: 0,
      gaps: 0,
      providers: 0,
      fields: 0,
      transcriptChecks: 0
    })
    const binding = reread.state.byId[TASK_ID].bindings[0]
    expect(binding.runs?.[0].transcriptCheck).toEqual(CHECK)
    expect(binding.sessions[0].transcriptCheck).toEqual(CHECK)
  })

  it('keeps the newest check, never mixes two stats, and treats a replay as no change', () => {
    const first = merge(bound(), [run({ transcriptCheck: CHECK })])
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }

    const replay = merge(first.state, [run({ transcriptCheck: CHECK })])
    expect(replay).toMatchObject({ ok: true, changed: false })

    // A newer stat that could not see the file replaces the whole check: the old
    // dev/ino/size are not carried over, because they describe a different stat.
    const gone = merge(
      first.state,
      [run({ transcriptCheck: { checkedAt: 2_500, presence: 'missing' } })],
      2_500
    )
    expect(gone.ok).toBe(true)
    if (!gone.ok) {
      return
    }
    expect(runsOf(gone.state)[0].transcriptCheck).toEqual({
      checkedAt: 2_500,
      presence: 'missing'
    })

    // An older observation is not newer evidence.
    const stale = merge(first.state, [
      run({ transcriptCheck: { ...CHECK, checkedAt: 50, size: 1 } })
    ])
    expect(stale).toMatchObject({ ok: true, changed: false })

    // Equal timestamps: the stored check wins (a fixed tie-break, so two
    // same-instant writers cannot flip the value and a replay stays a no-op).
    const tie = merge(first.state, [
      run({ transcriptCheck: { checkedAt: 2_100, presence: 'unverifiable' } })
    ])
    expect(tie).toMatchObject({ ok: true, changed: false })
    expect(runsOf(first.state)[0].transcriptCheck).toEqual(CHECK)

    // An observation with no check never erases a measured one.
    const blind = merge(first.state, [run({ transcriptCheck: undefined })])
    expect(blind).toMatchObject({ ok: true, changed: false })
  })
})


describe('resumeCommand and observation order (S1 / S8)', () => {
  it('stores the resume command as a measured fact and never erases it', () => {
    const command = 'claude --resume 0f3c -p /repo/feature'
    const first = merge(bound(), [run({ resumeCommand: command })])
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(runsOf(first.state)[0].resumeCommand).toBe(command)

    // Identical replay is still a no-op.
    expect(merge(first.state, [run({ resumeCommand: command })])).toMatchObject({
      ok: true,
      changed: false
    })
    // The hook path has no command; that absence must not erase the index's one.
    const hookReplay = merge(first.state, [run({ resumeCommand: undefined })])
    expect(hookReplay).toMatchObject({ ok: true, changed: false })
    expect(runsOf(first.state)[0].resumeCommand).toBe(command)
    // A newer observation may correct it.
    const corrected = merge(
      first.state,
      [run({ recordedAt: 4_000, lastSeenAt: 4_000, resumeCommand: 'codex resume abc' })],
      4_000
    )
    expect(corrected.ok).toBe(true)
    if (!corrected.ok) {
      return
    }
    expect(runsOf(corrected.state)[0].resumeCommand).toBe('codex resume abc')
  })

  it('does not let an older observation overwrite newer facts (S8)', () => {
    const newer = merge(
      bound(),
      [run({ recordedAt: 3_000, lastSeenAt: 3_000, endedAt: 2_900, messageCount: 40 })],
      3_000
    )
    expect(newer.ok).toBe(true)
    if (!newer.ok) {
      return
    }
    // A replay that carries t1 facts lands after t2. The row must keep the t2
    // facts, otherwise its t2 `recordedAt` would sit beside t1-era values.
    const stale = merge(
      newer.state,
      [
        run({
          recordedAt: 1_000,
          lastSeenAt: 2_100,
          endedAt: 1_500,
          messageCount: 5,
          title: 'stale title'
        })
      ],
      3_100
    )
    expect(stale).toMatchObject({ ok: true, changed: false })
    if (!stale.ok) {
      return
    }
    expect(runsOf(newer.state)[0]).toMatchObject({
      endedAt: 2_900,
      messageCount: 40,
      title: 'Resume the trace',
      recordedAt: 3_000
    })

    // A newer observation wins in the other direction.
    const fresher = merge(
      stale.state,
      [
        run({
          recordedAt: 4_000,
          lastSeenAt: 4_000,
          endedAt: 3_500,
          messageCount: 55,
          title: 'Resume the trace (final)'
        })
      ],
      4_000
    )
    expect(fresher.ok).toBe(true)
    if (!fresher.ok) {
      return
    }
    expect(runsOf(fresher.state)[0]).toMatchObject({
      endedAt: 3_500,
      messageCount: 55,
      title: 'Resume the trace (final)',
      firstSeenAt: 2_100,
      lastSeenAt: 4_000
    })
  })
})

describe('task records v2 load boundary', () => {
  const archiveSnapshot = run()

  function rawRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      taskId: TASK_ID,
      hostId: 'local',
      origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
      bindings: [
        {
          worktreeId: WORKTREE_ID,
          repoId: 'repo-1',
          hostId: 'local',
          path: '/repo/feature',
          isArchived: true,
          boundAt: 100,
          boundBy: 'user',
          lastVerifiedAt: 100,
          resolvedVia: 'locator',
          sessions: [],
          runs: []
        }
      ],
      intent: {},
      createdAt: 100,
      updatedAt: 100,
      schemaVersion: TASK_RECORD_SCHEMA_VERSION,
      ...overrides
    }
  }

  function domain(record: TaskRecord) {
    return {
      recordsVersion: 1,
      byId: { [record.taskId]: record },
      externalIndex: { 'github:repo-1:issue:31': record.taskId }
    }
  }

  it('round-trips a v2 record with runs through normalize → write → normalize', () => {
    const written = mergeTaskRecordRuns(bound(), {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      runs: [archiveSnapshot],
      gaps: [
        { kind: 'ambiguous_match', candidateCount: 2, observedAt: 2_100, detail: 'two sessions' }
      ],
      now: 2_100
    })
    expect(written.ok).toBe(true)
    if (!written.ok) {
      return
    }
    const loaded = normalizeTaskRecords(written.state)
    expect(loaded.readable).toBe(true)
    expect(loaded.state).toEqual(written.state)

    // Written to disk as JSON and read back by the next start.
    const reread = normalizeTaskRecords(JSON.parse(JSON.stringify(written.state)))
    expect(reread.state).toEqual(written.state)
    expect(reread.discarded).toEqual({
      sessions: 0,
      runs: 0,
      gaps: 0,
      providers: 0,
      fields: 0,
      transcriptChecks: 0
    })
    const binding = reread.state.byId[TASK_ID].bindings[0]
    expect(binding.runs).toEqual([archiveSnapshot])
    expect(binding.gaps).toEqual([
      { kind: 'ambiguous_match', candidateCount: 2, observedAt: 2_100, detail: 'two sessions' }
    ])
    expect(reread.state.byId[TASK_ID].schemaVersion).toBe(TASK_RECORD_SCHEMA_VERSION)
  })

  it('keeps a v1 record intact and does not upgrade its stored version on load', () => {
    const record = rawRecord({ schemaVersion: 1, bindings: [] })
    const loaded = normalizeTaskRecords(domain(record))

    expect(loaded.readable).toBe(true)
    expect(loaded.dropped).toBe(0)
    expect(loaded.state.byId[TASK_ID]).toEqual(record)
    expect(loaded.state.byId[TASK_ID].schemaVersion).toBe(1)
  })

  it('keeps a v1 binding without runs absent rather than writing an empty array', () => {
    const sessions = [
      { provider: 'claude' as const, key: 'session_id', id: 'abc', firstSeenAt: 1, lastSeenAt: 2 }
    ]
    // A v1 binding as issue #36 wrote it: no `runs` key at all.
    const legacyBinding = {
      worktreeId: WORKTREE_ID,
      repoId: 'repo-1',
      hostId: 'local' as const,
      path: '/repo/feature',
      isArchived: true,
      boundAt: 100,
      boundBy: 'user' as const,
      lastVerifiedAt: 100,
      resolvedVia: 'locator' as const,
      sessions
    }
    const loaded = normalizeTaskRecords(
      domain({ ...rawRecord({ schemaVersion: 1 }), bindings: [legacyBinding] })
    )

    // Absent, not `[]`: "never recorded" is not "looked and found none".
    expect(loaded.state.byId[TASK_ID].bindings[0]).not.toHaveProperty('runs')
    expect(loaded.state.byId[TASK_ID].bindings[0].sessions).toEqual(sessions)
    expect(loaded.state.byId[TASK_ID].schemaVersion).toBe(1)
  })

  it('rejects the whole domain when a record is newer than this build', () => {
    const raw = domain(rawRecord({ schemaVersion: TASK_RECORD_SCHEMA_VERSION + 1 }))
    const loaded = normalizeTaskRecords(raw)

    // The payload is preserved verbatim instead of being rewritten without the
    // record this build cannot read (T4).
    expect(loaded).toMatchObject({ state: EMPTY_TASK_RECORDS, readable: false })
  })

  it('drops and counts an illegal provider, unknown fields and over-cap rows', () => {
    // Rows this build cannot read in full, written the way a hand edit or an
    // older/newer writer would leave them.
    const dirty = [
      dirtyRow(),
      dirtyRow({ futureField: 'x' }),
      dirtyRow({ providerSession: { provider: 'pi', key: 'session_id', id: 'pi' } }),
      'not a row'
    ]
    const rows: unknown[] = [
      ...dirty,
      ...Array.from({ length: TASK_RECORDS_MAX_RUNS_PER_BINDING }, (_, index) =>
        run({
          key: taskRecordRunClaimKey({ provider: 'claude', key: 'session_id', id: `s${index}` }),
          providerSession: { provider: 'claude', key: 'session_id', id: `s${index}` }
        })
      )
    ]
    const dirtySessions: unknown[] = [
      {
        provider: 'pi',
        key: 'session_id',
        id: 'abc',
        futureField: 'x',
        firstSeenAt: 1,
        lastSeenAt: 2
      }
    ]
    const record = rawRecord({
      bindings: [
        {
          ...rawRecord().bindings[0],
          runs: rows as TaskRecordRun[],
          sessions: dirtySessions as TaskRecordSession[]
        }
      ]
    })
    const loaded = normalizeTaskRecords(domain(record))
    const binding = loaded.state.byId[TASK_ID].bindings[0]

    expect(binding.runs).toHaveLength(TASK_RECORDS_MAX_RUNS_PER_BINDING)
    // The unknown field is gone: the row is exactly the row this build can name.
    expect(binding.runs?.[1]).toEqual(run())
    // `pi` is a valid agent type and not one of the four usage providers, so the
    // run survives with the provider absent (unknown), never with the raw string.
    expect(binding.runs?.[2].providerSession).toEqual({ key: 'session_id', id: 'pi' })
    expect(binding.sessions).toEqual([
      { key: 'session_id', id: 'abc', firstSeenAt: 1, lastSeenAt: 2 }
    ])
    expect(loaded.discarded).toEqual({
      // 19 valid rows for a 16-row bound (3 over the cap), plus the string row.
      runs: 4,
      sessions: 0,
      gaps: 0,
      // 'pi' on one run and on one session.
      providers: 2,
      // `futureField` on one run and on one session, plus the `pi` row's stored
      // `key`, which no longer matches its claim (S10).
      fields: 3,
      transcriptChecks: 0
    })
  })

  it('drops and counts an unreadable transcript check but keeps the row', () => {
    const record = rawRecord({
      bindings: [
        {
          ...rawRecord().bindings[0],
          runs: [
            // Illegal `presence`: nothing here says whether the file is there.
            dirtyRow({ transcriptCheck: { checkedAt: 1, presence: 'gone' } }),
            // `present` without a timestamp cannot be weighed against a later stat.
            dirtyRow({ transcriptCheck: { presence: 'present', size: 5 } }),
            // One unreadable value drops that value only; the stat stays usable.
            dirtyRow({ transcriptCheck: { checkedAt: 7, presence: 'present', size: 'big' } }),
            dirtyRow({ transcriptCheck: 'present' })
          ] as TaskRecordRun[],
          sessions: [
            {
              provider: 'claude',
              key: 'session_id',
              id: 'abc',
              firstSeenAt: 1,
              lastSeenAt: 2,
              transcriptCheck: { checkedAt: 5, presence: 'unverifiable' }
            }
          ]
        }
      ]
    })
    const loaded = normalizeTaskRecords(domain(record))
    const binding = loaded.state.byId[TASK_ID].bindings[0]

    expect(binding.runs).toHaveLength(4)
    expect(binding.runs?.[0].transcriptCheck).toBeUndefined()
    expect(binding.runs?.[1].transcriptCheck).toBeUndefined()
    expect(binding.runs?.[2].transcriptCheck).toEqual({ checkedAt: 7, presence: 'present' })
    expect(binding.runs?.[3].transcriptCheck).toBeUndefined()
    expect(binding.sessions[0].transcriptCheck).toEqual({
      checkedAt: 5,
      presence: 'unverifiable'
    })
    expect(loaded.discarded).toEqual({
      sessions: 0,
      runs: 0,
      gaps: 0,
      providers: 0,
      // The one unreadable `size`.
      fields: 1,
      // Three unreadable checks: bad presence, no timestamp, not an object.
      transcriptChecks: 3
    })
  })

  it('rewrites a stored run key to its claim and counts the mismatch (S10)', () => {
    const record = rawRecord({
      bindings: [
        {
          ...rawRecord().bindings[0],
          runs: [dirtyRow({ key: 'run-1' })] as TaskRecordRun[]
        }
      ]
    })
    const loaded = normalizeTaskRecords(domain(record))

    // The reader dedupes on `key`, so a hand-edited key must not mint a second
    // identity for a session the merge already treats as one.
    expect(loaded.state.byId[TASK_ID].bindings[0].runs?.[0].key).toBe('claude|session_id:abc')
    expect(loaded.discarded.fields).toBe(1)
  })

  it('counts a present-but-unreadable gaps field (S9)', () => {
    const record = rawRecord({
      bindings: [{ ...rawRecord().bindings[0], gaps: 'not an array' as never }]
    })
    const loaded = normalizeTaskRecords(domain(record))

    // Same treatment as the `runs` arm: the unusable field is replaced by an
    // empty list and reported, so it is not silently absorbed.
    expect(loaded.state.byId[TASK_ID].bindings[0].gaps).toEqual([])
    expect(loaded.discarded.fields).toBe(1)
  })

  it('drops a run that cannot say how it was observed', () => {
    const record = rawRecord({
      bindings: [
        {
          ...rawRecord().bindings[0],
          runs: [
            dirtyRow({ source: 'guess' }),
            dirtyRow({ recordedAt: 'yesterday' })
          ] as TaskRecordRun[]
        }
      ]
    })
    const loaded = normalizeTaskRecords(domain(record))

    expect(loaded.state.byId[TASK_ID].bindings[0].runs).toEqual([])
    expect(loaded.discarded.runs).toBe(2)
    // One unreadable `source` plus one unreadable `recordedAt`.
    expect(loaded.discarded.fields).toBe(2)
  })
})

describe('schema version of a written record', () => {
  const session: TaskRecordSession = {
    provider: 'claude',
    key: 'session_id',
    id: 'abc',
    firstSeenAt: 100,
    lastSeenAt: 100
  }

  function v1Record(): TaskRecordsState {
    const loaded = normalizeTaskRecords({
      recordsVersion: 1,
      byId: {
        [TASK_ID]: {
          taskId: TASK_ID,
          hostId: 'local',
          origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
          bindings: [
            {
              worktreeId: WORKTREE_ID,
              repoId: 'repo-1',
              hostId: 'local',
              path: '/repo/feature',
              isArchived: true,
              boundAt: 100,
              boundBy: 'user',
              lastVerifiedAt: 100,
              sessions: []
            }
          ],
          intent: {},
          createdAt: 100,
          updatedAt: 100,
          schemaVersion: 1
        }
      },
      externalIndex: { 'github:repo-1:issue:31': TASK_ID }
    })
    return loaded.state
  }

  it('leaves a v1 record at 1 when a v1 session is merged into it', () => {
    const result = mergeTaskRecordBindingSessions(v1Record(), {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      sessions: [session],
      now: 200
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.state.byId[TASK_ID].schemaVersion).toBe(1)
  })

  it('raises a v1 record to 2 when a T2-style write stores runs: [] plus a gap (S3)', () => {
    const result = mergeTaskRecordRuns(v1Record(), {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      runs: [],
      gaps: [
        {
          kind: 'session_unattributable',
          candidateCount: 0,
          observedAt: 400,
          detail: 'no pane attribution and no index hit'
        }
      ],
      now: 400
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const binding = result.state.byId[TASK_ID].bindings[0]
    // An empty run list is still a v2 statement ("the writer looked"), so the
    // record may not keep claiming v1.
    expect(binding.runs).toEqual([])
    expect(binding.gaps).toHaveLength(1)
    expect(result.state.byId[TASK_ID].schemaVersion).toBe(TASK_RECORD_SCHEMA_VERSION)
  })

  it('raises a v1 record to 2 when only a transcript check is stored (S3)', () => {
    const result = mergeTaskRecordBindingSessions(v1Record(), {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      sessions: [{ ...session, transcriptCheck: { checkedAt: 10, presence: 'present' } }],
      now: 10
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.state.byId[TASK_ID].schemaVersion).toBe(TASK_RECORD_SCHEMA_VERSION)
  })

  it('raises a v1 record to 2 only when a v2 fact is actually stored', () => {
    const withSource = mergeTaskRecordBindingSessions(v1Record(), {
      taskId: TASK_ID,
      worktreeId: WORKTREE_ID,
      hostId: 'local',
      sessions: [{ ...session, source: 'backfill', recordedAt: 300 }],
      now: 300
    })
    expect(withSource.ok).toBe(true)
    if (!withSource.ok) {
      return
    }
    expect(withSource.state.byId[TASK_ID].schemaVersion).toBe(TASK_RECORD_SCHEMA_VERSION)
  })
})
