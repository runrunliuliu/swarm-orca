import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  historyBackfillResultSchema,
  parseHistoryBackfillTaskArgument,
  type HistoryBackfillTask
} from '../../shared/history-backfill-command'
import { normalizeTaskRecords } from '../../shared/task-records-normalize'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../persistence/profile-state/profile-state-documents'
import { upsertTaskRecordBinding } from '../../shared/task-records-updates'
import {
  EMPTY_TASK_RECORDS,
  type TaskRecord,
  type TaskRecordsState,
  type TaskWorkspaceBinding
} from '../../shared/task-records-types'
import { resolveBackfillRepoId, resolveBackfillTaskRecord } from './task-records-backfill'
import { backfillTaskRecords } from './task-records-backfill-profile-state'
import { createTranscriptCheckProbe } from './task-records-transcript-check'
import type { TaskRecordsSessionIndexLookup } from './task-records-session-index-lookup'

const REPO_ID = 'repo-1'
const WORKTREE_ID = 'repo-1::/repos/app'
const WORKTREE_PATH = '/repos/app'
const TASK_ID = 'task:github:repo-1:issue:53'
const BOUND_AT = 1_000
const NOW = 2_000

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-history-backfill-'))
  directories.push(directory)
  return directory
}

type Fixture = {
  directory: string
  location: { dataFile: string; databaseFile: string; profileId: string }
  transcriptPath: string
}

/** A profile whose SQLite authority holds `repos` + `taskRecords`, exactly as the
 *  app leaves it for an archived workspace of issue #53. */
function profileFixture(
  state: TaskRecordsState = stateWithBinding(),
  repos: unknown = [{ id: REPO_ID, path: WORKTREE_PATH }]
): Fixture {
  const directory = fixtureDirectory()
  const profileId = 'profile-backfill'
  const databaseFile = join(directory, 'profile-state.db')
  const transcriptPath = join(directory, 'sess-1.jsonl')
  writeFileSync(transcriptPath, '{"type":"user"}\n')
  const opened = openProfileStateDatabase(databaseFile, profileId)
  try {
    importProfileStateJson(opened.db, JSON.stringify({ repos, taskRecords: state }))
  } finally {
    opened.db.close()
  }
  return {
    directory,
    location: { dataFile: join(directory, 'orca-data.json'), databaseFile, profileId },
    transcriptPath
  }
}

/** The record as an older build left it: `schemaVersion: 1`, `sessions: []`,
 *  archived, no `runs`/`gaps` — the issue's exact starting condition. */
function stateWithBinding(
  overrides: {
    path?: string
    hostId?: 'local' | `ssh:${string}`
    isArchived?: boolean
    number?: number
    itemType?: 'issue' | 'pr'
    provider?: 'github' | 'linear'
  } = {}
): TaskRecordsState {
  const number = overrides.number ?? 53
  const taskId = `task:${overrides.provider ?? 'github'}:${REPO_ID}:${overrides.itemType ?? 'issue'}:${number}`
  const written = upsertTaskRecordBinding(EMPTY_TASK_RECORDS, {
    taskId,
    hostId: overrides.hostId ?? 'local',
    repoId: REPO_ID,
    worktreeId: WORKTREE_ID,
    path: overrides.path ?? WORKTREE_PATH,
    isArchived: overrides.isArchived ?? true,
    origin: {
      kind: 'external',
      provider: overrides.provider ?? 'github',
      itemType: overrides.itemType ?? 'issue',
      number
    },
    now: BOUND_AT,
    boundBy: 'user'
  })
  if (!written.ok) {
    throw new Error('fixture could not bind the workspace')
  }
  const record = written.state.byId[taskId]
  return {
    ...written.state,
    byId: {
      ...written.state.byId,
      [taskId]: { ...record, schemaVersion: 1 }
    }
  }
}

/** One frame of the record state, read back from disk (what the app would load). */
function storedRecord(fixture: Fixture, taskId = TASK_ID): TaskRecord {
  const opened = openProfileStateDatabaseReadOnly(fixture.location.databaseFile, 'profile-backfill')
  try {
    const payload = JSON.parse(exportProfileStateJson(opened.db)) as {
      taskRecords: TaskRecordsState
    }
    const record = payload.taskRecords.byId[taskId]
    if (!record) {
      throw new Error(`fixture expects ${taskId} to be stored`)
    }
    return record
  } finally {
    opened.db.close()
  }
}

function storedPayload(fixture: Fixture): string {
  const opened = openProfileStateDatabaseReadOnly(fixture.location.databaseFile, 'profile-backfill')
  try {
    return exportProfileStateJson(opened.db)
  } finally {
    opened.db.close()
  }
}

function bindingOf(record: TaskRecord): TaskWorkspaceBinding {
  const binding = record.bindings[0]
  if (!binding) {
    throw new Error('fixture expects one binding')
  }
  return binding
}

function indexSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'row-1',
    executionHostId: 'local',
    agent: 'pi',
    sessionId: 'sess-1',
    title: 'Refactor the task ledger',
    cwd: WORKTREE_PATH,
    branch: null,
    model: null,
    filePath: '/tmp/does-not-exist/sess-1.jsonl',
    codexHome: null,
    createdAt: new Date(1_500).toISOString(),
    updatedAt: new Date(1_900).toISOString(),
    modifiedAt: new Date(1_900).toISOString(),
    messageCount: 7,
    totalTokens: 12_345,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'pi --resume sess-1',
    subagent: null,
    ...overrides
  }
}

/** The lookup seam, instrumented so a test can prove it was (not) called. */
type InstrumentedLookup = TaskRecordsSessionIndexLookup & { paths: string[] }

function lookupReturning(sessions: readonly AiVaultSession[]): InstrumentedLookup {
  const paths: string[] = []
  const lookup = (async (args: { path: string }) => {
    paths.push(args.path)
    return sessions
  }) as InstrumentedLookup
  lookup.paths = paths
  return lookup
}

function task(): HistoryBackfillTask {
  return parseHistoryBackfillTaskArgument(`${REPO_ID}#53`)
}

async function run(
  fixture: Fixture,
  options: {
    sessions?: readonly AiVaultSession[]
    now?: number
    task?: HistoryBackfillTask
  } = {}
) {
  const lookup = lookupReturning(options.sessions ?? [])
  return {
    lookup,
    report: await backfillTaskRecords({
      location: fixture.location,
      task: options.task ?? task(),
      now: options.now ?? NOW,
      sessionIndexLookup: lookup,
      transcriptCheck: createTranscriptCheckProbe(() => options.now ?? NOW)
    })
  }
}

describe('history backfill repository and task resolution', () => {
  const repos = [
    { id: 'repo-1', path: '/repos/app' },
    { id: 'repo-2', path: '/repos/other' }
  ]

  it.each([
    { selector: { kind: 'auto', value: 'repo-1' }, expected: 'repo-1' },
    { selector: { kind: 'id', value: 'repo-2' }, expected: 'repo-2' },
    { selector: { kind: 'path', value: '/repos/app/' }, expected: 'repo-1' },
    { selector: { kind: 'auto', value: '/repos/other' }, expected: 'repo-2' }
  ] as const)('resolves $selector to $expected', ({ selector, expected }) => {
    expect(resolveBackfillRepoId(repos, selector)).toBe(expected)
  })

  it('refuses a repo value it cannot resolve instead of picking one', () => {
    expect(() => resolveBackfillRepoId(repos, { kind: 'auto', value: 'repo-9' })).toThrow(
      /No registered repo matches/
    )
    expect(() =>
      resolveBackfillRepoId([...repos, { id: 'repo-3', path: '/repos/app' }], {
        kind: 'path',
        value: '/repos/app'
      })
    ).toThrow(/matches 2 registered repos/)
  })

  it('refuses a task number two records claim instead of guessing', () => {
    const state = stateWithBinding()
    const linear = stateWithBinding({ provider: 'linear' })
    const both: TaskRecordsState = {
      recordsVersion: 1,
      byId: { ...state.byId, ...linear.byId },
      externalIndex: {}
    }
    expect(() => resolveBackfillTaskRecord(both, { repoId: REPO_ID, task: task() })).toThrow(
      /matches 2 task records/
    )
    // A stated item type narrows the set; it still never picks between providers.
    expect(() =>
      resolveBackfillTaskRecord(both, {
        repoId: REPO_ID,
        task: { ...task(), itemType: 'pr' }
      })
    ).toThrow(/No task record for/)
    expect(
      resolveBackfillTaskRecord(
        {
          recordsVersion: 1,
          byId: { [TASK_ID]: stateWithBinding().byId[TASK_ID] },
          externalIndex: {}
        },
        { repoId: REPO_ID, task: { ...task(), itemType: 'issue' } }
      ).taskId
    ).toBe(TASK_ID)
  })

  it('reports a task with no record as an actionable error', () => {
    expect(() =>
      resolveBackfillTaskRecord(stateWithBinding(), { repoId: 'repo-9', task: task() })
    ).toThrow(/No task record for repo-9#53/)
  })
})

describe('history backfill (T1, the headline regression)', () => {
  it('reconstructs one run for an archived workspace with an empty session list', async () => {
    const fixture = profileFixture()
    const { report } = await run(fixture, {
      sessions: [indexSession({ filePath: fixture.transcriptPath })]
    })

    // The report states what it did, and no token figure appears anywhere.
    expect(report).toMatchObject({
      taskId: TASK_ID,
      repoId: REPO_ID,
      number: 53,
      provider: 'github',
      itemType: 'issue',
      bindings: 1,
      examined: 1,
      resolved: 1,
      rowsWritten: { sessions: 1, runs: 1 },
      changed: true
    })
    expect(report.revision).toBe(2)
    expect(report.outcomes).toEqual([
      {
        worktreeId: WORKTREE_ID,
        hostId: 'local',
        path: WORKTREE_PATH,
        outcome: 'resolved',
        sessionRows: 1,
        runRows: 1
      }
    ])

    const record = storedRecord(fixture)
    const binding = bindingOf(record)
    expect(binding.sessions).toHaveLength(1)
    expect(binding.sessions[0]).toMatchObject({
      // pi is an agent type, not one of the four usage providers: `provider` stays absent.
      key: 'sessionId',
      id: 'sess-1',
      agentType: 'pi',
      title: 'Refactor the task ledger',
      transcriptPath: fixture.transcriptPath,
      resumeCommand: 'pi --resume sess-1',
      startedAt: 1_500,
      endedAt: 1_900,
      messageCount: 7,
      source: 'backfill',
      recordedAt: NOW,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      transcriptCheck: { checkedAt: NOW, presence: 'present' }
    })
    expect(binding.sessions[0]?.provider).toBeUndefined()

    expect(binding.runs).toHaveLength(1)
    expect(binding.runs?.[0]).toMatchObject({
      // The claim identity is shared with the snapshot writer.
      key: 'unknown|sessionId:sess-1',
      providerSession: { key: 'sessionId', id: 'sess-1' },
      agentType: 'pi',
      resumeCommand: 'pi --resume sess-1',
      startedAt: 1_500,
      endedAt: 1_900,
      messageCount: 7,
      source: 'backfill',
      recordedAt: NOW,
      firstSeenAt: NOW,
      lastSeenAt: NOW
    })
    expect(binding.runs?.[0]?.providerSession.provider).toBeUndefined()
    expect(binding.gaps).toBeUndefined()
    // The writer stored a v2 fact, so the record says so (seat A's rule).
    expect(record.schemaVersion).toBe(2)

    // Unknown usage is an absence, never a figure: no settlement, no 0, and the
    // index's own totalTokens is not promoted into a worktree figure.
    expect(binding.usageSettlement).toBeUndefined()
    expect(JSON.stringify(binding)).not.toContain('"tokens"')
    expect(JSON.stringify(binding)).not.toContain('12345')
  })
})

describe('history backfill idempotency (A6)', () => {
  it('writes nothing at all when the command is run twice (A6)', async () => {
    const fixture = profileFixture()
    const sessions = [indexSession({ filePath: fixture.transcriptPath })]
    const first = await run(fixture, { sessions })
    expect(first.report).toMatchObject({ examined: 1, resolved: 1, changed: true })
    const stored = storedPayload(fixture)

    // The issue's selection is what makes the command idempotent: the binding now has
    // sessions, so the second run does not even look at it — no scan, no rows, no write.
    const second = await run(fixture, { sessions })
    expect(second.report).toMatchObject({
      examined: 0,
      resolved: 0,
      changed: false,
      revision: null,
      rowsWritten: { sessions: 0, runs: 0 },
      // A clean domain discards nothing, so the new report fields say zero and
      // nothing at all is refused (R1 changed no behaviour in this case).
      discarded: {
        sessions: 0,
        runs: 0,
        gaps: 0,
        providers: 0,
        fields: 0,
        transcriptChecks: 0
      },
      writeRefusedReason: null
    })
    expect(second.report.outcomes).toEqual([])
    expect(second.lookup.paths).toEqual([])
    expect(storedPayload(fixture)).toBe(stored)

    const binding = bindingOf(storedRecord(fixture))
    expect(binding.sessions).toHaveLength(1)
    expect(binding.runs).toHaveLength(1)
  })

  it('unions the window and keeps first-writer provenance on a re-observation (A6 rule)', async () => {
    // The backfill itself only selects empty session lists, so the union rule is pinned
    // where a later observation can reach the same claim: a record that already holds
    // the run (an archive snapshot) but no session rows.
    const archived = stateWithBinding()
    const record = archived.byId[TASK_ID]
    const fixture = profileFixture({
      ...archived,
      byId: {
        ...archived.byId,
        [TASK_ID]: {
          ...record,
          bindings: record.bindings.map((entry) => ({
            ...entry,
            runs: [
              {
                key: 'unknown|sessionId:sess-1',
                providerSession: { key: 'sessionId', id: 'sess-1' },
                agentType: 'pi',
                source: 'archive-snapshot' as const,
                recordedAt: 1_300,
                firstSeenAt: 1_200,
                lastSeenAt: 1_300
              }
            ]
          }))
        }
      }
    })

    const { report } = await run(fixture, {
      sessions: [indexSession({ filePath: fixture.transcriptPath })],
      now: NOW
    })
    expect(report).toMatchObject({ examined: 1, resolved: 1, changed: true })

    const binding = bindingOf(storedRecord(fixture))
    // One session row (it had none) and still one run row (same claim, not a duplicate).
    expect(binding.sessions).toHaveLength(1)
    expect(binding.sessions[0]).toMatchObject({ source: 'backfill', recordedAt: NOW })
    expect(binding.runs).toHaveLength(1)
    expect(binding.runs?.[0]).toMatchObject({
      key: 'unknown|sessionId:sess-1',
      // Provenance is first-writer-wins: a backfill never relabels an archive-snapshot row.
      source: 'archive-snapshot',
      recordedAt: 1_300,
      // The observation window is the union: earlier edge kept, later edge advanced.
      firstSeenAt: 1_200,
      lastSeenAt: NOW
    })
  })
})

describe('history backfill storage preconditions', () => {
  it('refuses a profile that has no SQLite authority yet', async () => {
    const fixture = profileFixture()
    rmSync(fixture.location.databaseFile, { force: true })
    writeFileSync(fixture.location.dataFile, JSON.stringify({ settings: {} }))
    await expect(run(fixture)).rejects.toThrow(/no SQLite profile state yet/)
  })

  it('refuses a legacy JSON the database has not accepted, so the next start cannot discard the write', async () => {
    const fixture = profileFixture()
    const before = storedPayload(fixture)
    writeFileSync(fixture.location.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    await expect(run(fixture, { sessions: [indexSession()] })).rejects.toThrow(
      /without a matching acceptance marker/
    )
    expect(storedPayload(fixture)).toBe(before)
  })
})

describe('history backfill selection and gaps', () => {
  it('is a successful no-op with an explicit count when nothing qualifies', async () => {
    const fixture = profileFixture(stateWithBinding({ isArchived: false }))
    const before = storedPayload(fixture)
    const { lookup, report } = await run(fixture, { sessions: [indexSession()] })

    expect(report).toMatchObject({ examined: 0, resolved: 0, changed: false, revision: null })
    expect(report.outcomes).toEqual([])
    expect(storedPayload(fixture)).toBe(before)
    expect(lookup.paths).toEqual([])
  })

  it('records a bounded unattributable gap instead of an empty authoritative list (T2)', async () => {
    const fixture = profileFixture()
    const { report } = await run(fixture, { sessions: [] })

    expect(report).toMatchObject({ examined: 1, resolved: 0, changed: true })
    expect(report.outcomes[0]).toMatchObject({
      outcome: 'session_unattributable',
      sessionRows: 0,
      runRows: 0
    })
    const binding = bindingOf(storedRecord(fixture))
    expect(binding.sessions).toEqual([])
    expect(binding.runs).toEqual([])
    expect(binding.gaps).toHaveLength(1)
    expect(binding.gaps?.[0]).toMatchObject({
      kind: 'session_unattributable',
      candidateCount: 0,
      observedAt: NOW
    })
    expect(binding.gaps?.[0]?.detail).toContain('bounded scan')
    expect(report.outcomes[0]?.detail).toBe(binding.gaps?.[0]?.detail)
    // `runs: []` plus a gap is a v2 fact, so the record says so (seat A's rule).
    expect(storedRecord(fixture).schemaVersion).toBe(2)
  })

  it('refuses to guess between two sessions the window cannot separate (T3)', async () => {
    const fixture = profileFixture()
    const { report } = await run(fixture, {
      sessions: [indexSession(), indexSession({ id: 'row-2', sessionId: 'sess-2' })]
    })

    expect(report.outcomes[0]).toMatchObject({
      outcome: 'ambiguous_match',
      candidateCount: 2,
      sessionRows: 0,
      runRows: 0
    })
    const binding = bindingOf(storedRecord(fixture))
    expect(binding.sessions).toEqual([])
    expect(binding.runs).toEqual([])
    expect(binding.gaps).toEqual([
      expect.objectContaining({ kind: 'ambiguous_match', candidateCount: 2 })
    ])
  })

  it('does not scan for a workspace another host owns', async () => {
    const fixture = profileFixture(stateWithBinding({ hostId: 'ssh:build-box' }))
    const { lookup, report } = await run(fixture, { sessions: [indexSession()] })

    expect(report.outcomes[0]).toMatchObject({ outcome: 'other_host' })
    expect(lookup.paths).toEqual([])
    const binding = bindingOf(storedRecord(fixture))
    expect(binding.runs).toEqual([])
    expect(binding.gaps?.[0]?.detail).toContain('another host')
  })

  it('ignores a session outside the binding window', async () => {
    const fixture = profileFixture()
    const { report } = await run(fixture, {
      // Ended before the workspace was bound to this task.
      sessions: [
        indexSession({
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          modifiedAt: new Date(20).toISOString()
        })
      ]
    })

    expect(report.outcomes[0]).toMatchObject({ outcome: 'session_unattributable' })
    expect(bindingOf(storedRecord(fixture)).sessions).toEqual([])
  })

  it('refuses an over-cap write instead of truncating it (A4)', async () => {
    const fixture = profileFixture()
    const seeded = stateWithBinding()
    // A binding at the run cap whose session list is still empty: the run merge must
    // refuse, and the session half must not be written on its own.
    const record = seeded.byId[TASK_ID]
    const full: TaskRecordsState = {
      ...seeded,
      byId: {
        ...seeded.byId,
        [TASK_ID]: {
          ...record,
          bindings: record.bindings.map((entry) => ({
            ...entry,
            runs: Array.from({ length: 16 }, (_, index) => ({
              key: `unknown|sessionId:other-${index}`,
              providerSession: { key: 'sessionId', id: `other-${index}` },
              source: 'backfill' as const,
              recordedAt: BOUND_AT,
              firstSeenAt: BOUND_AT,
              lastSeenAt: BOUND_AT
            }))
          }))
        }
      }
    }
    seed(fixture, full)
    const before = storedPayload(fixture)

    const { report } = await run(fixture, { sessions: [indexSession()] })
    expect(report.outcomes[0]).toMatchObject({ outcome: 'refused', refusedReason: 'limit' })
    expect(report).toMatchObject({ changed: false, rowsWritten: { sessions: 0, runs: 0 } })
    expect(storedPayload(fixture)).toBe(before)
  })
})

describe('history backfill load-time discard (R1)', () => {
  /** A stored domain whose `runs` list is past the per-binding cap: what a
   *  hand-edited or over-cap payload looks like to this build. Written straight into
   *  the profile database (no writer could produce it — that is the point). */
  function overCapState(runCount: number): TaskRecordsState {
    const seeded = stateWithBinding()
    const record = seeded.byId[TASK_ID]
    if (!record) {
      throw new Error('fixture expects the seeded record')
    }
    return {
      ...seeded,
      byId: {
        ...seeded.byId,
        [TASK_ID]: {
          ...record,
          bindings: record.bindings.map((entry) => ({
            ...entry,
            runs: Array.from({ length: runCount }, (_, index) => ({
              key: `unknown|sessionId:other-${index}`,
              providerSession: { key: 'sessionId' as const, id: `other-${index}` },
              source: 'backfill' as const,
              recordedAt: BOUND_AT,
              firstSeenAt: BOUND_AT,
              lastSeenAt: BOUND_AT
            }))
          }))
        }
      }
    }
  }

  it('writes nothing and reports the discard when the stored runs are over the cap', async () => {
    const fixture = profileFixture()
    seed(fixture, overCapState(17))
    const before = storedPayload(fixture)

    // The premise, measured rather than assumed: the load boundary trims this list
    // to the first 16 and counts one row. A write of the normalized domain would
    // therefore persist a shortened record that nothing can restore.
    const load = normalizeTaskRecords(
      (JSON.parse(before) as { taskRecords: TaskRecordsState }).taskRecords
    )
    expect(load.discarded.runs).toBe(1)
    expect(load.state.byId[TASK_ID]?.bindings[0]?.runs).toHaveLength(16)

    // No session in the index, i.e. the unrelated-command case the review describes:
    // the run records a bounded gap, which grows the binding, so the old code reached
    // its write and stored the trimmed 16 rows instead of the 17 it read.
    const { lookup, report } = await run(fixture)

    // The proof that matters, asserted first: the stored payload is byte-identical.
    const after = storedPayload(fixture)
    expect(after).toBe(before)
    const stored = (JSON.parse(after) as { taskRecords: TaskRecordsState }).taskRecords
    expect(stored.byId[TASK_ID]?.bindings[0]?.runs).toHaveLength(17)
    // Nothing was attributed, so no gap was written either: the run stopped before
    // the scan rather than reporting a "bounded scan" that never happened.
    expect(stored.byId[TASK_ID]?.bindings[0]?.gaps).toBeUndefined()
    expect(lookup.paths).toEqual([])

    // An explicit refusal, not a "nothing to do": the report names the loss and
    // every counter that would otherwise read as a successful empty run is zero.
    expect(report.writeRefusedReason).toBe('load_discarded_runs')
    expect(report.discarded).toMatchObject({ runs: 1, sessions: 0, gaps: 0, fields: 0 })
    expect(report).toMatchObject({
      examined: 0,
      resolved: 0,
      rowsWritten: { sessions: 0, runs: 0 },
      changed: false,
      revision: null
    })
    expect(report.outcomes).toEqual([])

    // And the printed/JSON shape is the contract this report has to satisfy.
    expect(historyBackfillResultSchema.safeParse(report).success).toBe(true)
  })

  it('still writes a clean domain (the refusal is not a blanket read-only mode)', async () => {
    const fixture = profileFixture()
    const { report } = await run(fixture, {
      sessions: [indexSession({ filePath: fixture.transcriptPath })]
    })
    expect(report.writeRefusedReason).toBeNull()
    expect(report.discarded).toMatchObject({ runs: 0, sessions: 0, gaps: 0, fields: 0 })
    expect(report).toMatchObject({ examined: 1, resolved: 1, changed: true })
    expect(report.revision).not.toBeNull()
    expect(historyBackfillResultSchema.safeParse(report).success).toBe(true)
    expect(bindingOf(storedRecord(fixture)).sessions).toHaveLength(1)
  })
})

/** Re-seed an already-open fixture with another state. */
function seed(fixture: Fixture, state: TaskRecordsState): void {
  const opened = openProfileStateDatabase(fixture.location.databaseFile, 'profile-backfill')
  try {
    importProfileStateJson(
      opened.db,
      JSON.stringify({ repos: [{ id: REPO_ID, path: WORKTREE_PATH }], taskRecords: state })
    )
  } finally {
    opened.db.close()
  }
}
