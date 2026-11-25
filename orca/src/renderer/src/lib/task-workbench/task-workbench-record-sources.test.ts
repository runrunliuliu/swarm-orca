import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { RUNTIME_COMPAT_BLOCK_CODE } from '@/runtime/runtime-protocol-compat'
import type {
  TaskRecord,
  TaskRecordRun,
  TaskRecordSession
} from '../../../../shared/task-records-types'
import {
  mergeTaskRecordSources,
  selectTaskRecordEnvironments,
  taskRecordSourcesComplete,
  worktreeRecordHostId,
  type TaskRecordSourceAnswer
} from './task-workbench-record-sources'
import { projectTaskRecordSource } from './task-workbench-record-source-view'
import { classifyTaskRecordsRemoteFailure } from './task-workbench-record-source-failures'

/**
 * The cross-profile merge (issue #31).
 *
 * What this file owns: which profiles are asked, that no fact is lost when two
 * profiles describe one task, who wins when they disagree, and that a source that
 * could not answer is never turned into "no history". Every fixture is synthetic;
 * the merge is exercised here and the record's own folds (archived/deleted forms,
 * settlements) are exercised in `task-workbench-history-merge.test.ts`, so nothing
 * here re-derives them.
 */

const ENV_A = 'env-a'

function session(id: string, overrides: Partial<TaskRecordSession> = {}): TaskRecordSession {
  return {
    provider: 'claude',
    key: 'session_id',
    id,
    firstSeenAt: 10,
    lastSeenAt: 20,
    ...overrides
  }
}

function run(id: string, overrides: Partial<TaskRecordRun> = {}): TaskRecordRun {
  return {
    key: `claude|session_id:${id}`,
    providerSession: { provider: 'claude', key: 'session_id', id },
    source: 'archive-snapshot',
    recordedAt: 30,
    firstSeenAt: 10,
    lastSeenAt: 20,
    ...overrides
  }
}

function binding(overrides: {
  worktreeId: string
  hostId: TaskRecord['bindings'][number]['hostId']
  path?: string
  isArchived?: boolean
  sessions?: TaskRecordSession[]
  runs?: TaskRecordRun[]
}): TaskRecord['bindings'][number] {
  return {
    worktreeId: overrides.worktreeId,
    repoId: 'repo-1',
    hostId: overrides.hostId,
    path: overrides.path ?? `/checkouts/${overrides.worktreeId}`,
    isArchived: overrides.isArchived ?? true,
    boundAt: 1,
    boundBy: 'created',
    lastVerifiedAt: 2,
    sessions: overrides.sessions ?? [],
    ...(overrides.runs === undefined ? {} : { runs: overrides.runs })
  }
}

function record(
  hostId: TaskRecord['hostId'],
  bindings: TaskRecord['bindings'],
  overrides: Partial<TaskRecord> = {}
): TaskRecord {
  return {
    taskId: 'task:github:repo-1:issue:7',
    hostId,
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 7 },
    bindings,
    intent: { archived: true },
    createdAt: 1,
    updatedAt: 5,
    schemaVersion: 3,
    ...overrides
  }
}

function answered(environmentId: string, answer: TaskRecord | null): TaskRecordSourceAnswer {
  return {
    target: { kind: 'environment', environmentId },
    kind: 'answered',
    record: answer
  }
}

describe('selectTaskRecordEnvironments', () => {
  it('asks nothing when every workspace is local or a direct ssh target', () => {
    expect(
      selectTaskRecordEnvironments({
        worktreeHostIds: ['local', 'ssh:box-1', undefined]
      })
    ).toEqual([])
  })

  it('asks each runtime environment once, in the order the evidence names them', () => {
    expect(
      selectTaskRecordEnvironments({
        worktreeHostIds: ['runtime:env-b', 'local', 'runtime:env-a', 'runtime:env-b'],
        bindingHostIds: ['runtime:env-c', 'runtime:env-a']
      })
    ).toEqual(['env-b', 'env-a', 'env-c'])
  })

  it('reads a workspace row the way the store spells its owner', () => {
    expect(worktreeRecordHostId({ runtimeOwnerEnvironmentId: 'env-a' })).toBe('runtime:env-a')
    expect(worktreeRecordHostId({ hostId: 'ssh:box-1' })).toBe('ssh:box-1')
    // An absent pair is unknown, not local: no focused environment is guessed.
    expect(worktreeRecordHostId({})).toBeUndefined()
  })
})

describe('mergeTaskRecordSources', () => {
  it('returns the local record itself when no environment applies', () => {
    const local = record('local', [binding({ worktreeId: 'wt-1', hostId: 'local' })], {
      updatedAt: 9
    })
    const sources = mergeTaskRecordSources({ local, answers: [] })

    // The same object, not an equal copy: a local-only task must take exactly the
    // path it took before this feature existed.
    expect(sources.record).toBe(local)
    expect(sources.answered).toEqual([{ kind: 'local' }])
    expect(sources.unavailable).toEqual([])
    expect(sources.conflicts).toEqual([])
    expect(taskRecordSourcesComplete(sources)).toBe(true)
  })

  it('reports a local read even when it produced no record', () => {
    const sources = mergeTaskRecordSources({ local: null, answers: [] })
    expect(sources.record).toBeNull()
    expect(sources.answered).toEqual([{ kind: 'local' }])
    expect(sources.unavailable).toEqual([])
  })

  it('keeps the local content when the only environment could not answer', () => {
    const local = record('local', [binding({ worktreeId: 'wt-1', hostId: 'local' })])
    const sources = mergeTaskRecordSources({
      local,
      answers: [
        {
          target: { kind: 'environment', environmentId: ENV_A },
          kind: 'unavailable',
          failure: 'unsupported'
        }
      ]
    })

    expect(sources.record).toBe(local)
    expect(sources.unavailable).toEqual([
      { target: { kind: 'environment', environmentId: ENV_A }, failure: 'unsupported' }
    ])
    expect(taskRecordSourcesComplete(sources)).toBe(false)
  })

  it('shows a record that only the remote profile has', () => {
    // The bug this feature fixes: the local profile recorded nothing, so the page
    // said "never started" about a task the runtime archived.
    const remote = record('runtime:env-a', [
      binding({ worktreeId: 'wt-remote', hostId: 'runtime:env-a' })
    ])
    const sources = mergeTaskRecordSources({ local: null, answers: [answered(ENV_A, remote)] })

    expect(sources.record).toBe(remote)
    expect(sources.answered).toEqual([
      { kind: 'local' },
      { kind: 'environment', environmentId: ENV_A }
    ])
  })

  it('scopes a runtime profile local binding to the environment that answered', () => {
    const remote = record('local', [
      binding({ worktreeId: 'wt-remote', hostId: 'local', isArchived: true })
    ])
    const sources = mergeTaskRecordSources({ local: null, answers: [answered(ENV_A, remote)] })

    expect(sources.record).not.toBe(remote)
    expect(sources.record).toMatchObject({
      hostId: 'runtime:env-a',
      bindings: [{ worktreeId: 'wt-remote', hostId: 'runtime:env-a', isArchived: true }]
    })
  })

  it('tells "asked and empty" apart from "could not ask"', () => {
    const empty = mergeTaskRecordSources({ local: null, answers: [answered(ENV_A, null)] })
    expect(empty.record).toBeNull()
    // Both profiles were read; the local one simply had nothing.
    expect(empty.answered).toEqual([
      { kind: 'local' },
      { kind: 'environment', environmentId: ENV_A }
    ])
    expect(empty.unavailable).toEqual([])

    const unheard = mergeTaskRecordSources({
      local: null,
      answers: [
        {
          target: { kind: 'environment', environmentId: ENV_A },
          kind: 'unavailable',
          failure: 'unreachable'
        }
      ]
    })
    expect(unheard.record).toBeNull()
    expect(unheard.answered).toEqual([{ kind: 'local' }])
    expect(unheard.unavailable).toHaveLength(1)
  })

  it('unions bindings from both profiles instead of picking one', () => {
    const local = record('local', [binding({ worktreeId: 'wt-local', hostId: 'local' })], {
      updatedAt: 4
    })
    const remote = record(
      'runtime:env-a',
      [binding({ worktreeId: 'wt-remote', hostId: 'runtime:env-a' })],
      { createdAt: 2, updatedAt: 9, schemaVersion: 3 }
    )
    const sources = mergeTaskRecordSources({ local, answers: [answered(ENV_A, remote)] })
    const merged = sources.record

    expect(merged?.bindings.map((entry) => entry.worktreeId)).toEqual(['wt-local', 'wt-remote'])
    expect(merged?.createdAt).toBe(1)
    expect(merged?.updatedAt).toBe(9)
    expect(sources.conflicts).toEqual([])
  })

  it('lets the binding-owned profile keep identity fields and unions the facts', () => {
    const localBinding = binding({
      worktreeId: 'wt-shared',
      hostId: 'runtime:env-a',
      path: '/checkouts/stale',
      isArchived: false,
      sessions: [session('a')]
    })
    const remoteBinding = binding({
      worktreeId: 'wt-shared',
      hostId: 'runtime:env-a',
      path: '/checkouts/real',
      isArchived: true,
      sessions: [session('a', { lastSeenAt: 25 }), session('b')],
      runs: [run('a')]
    })
    const local = record('local', [localBinding])
    const remote = record('runtime:env-a', [remoteBinding])

    const sources = mergeTaskRecordSources({ local, answers: [answered(ENV_A, remote)] })
    const merged = sources.record?.bindings[0]

    // Identity fields: the environment owns `runtime:env-a`, so its values win.
    expect(merged?.path).toBe('/checkouts/real')
    expect(merged?.isArchived).toBe(true)
    // Facts: a row only one profile saw is kept, and the newer observation of a
    // row both saw keeps the newer facts.
    expect(merged?.sessions.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(merged?.sessions[0].lastSeenAt).toBe(25)
    expect(merged?.runs?.map((entry) => entry.key)).toEqual([run('a').key])
    // A real disagreement is reported, not swallowed.
    expect(sources.conflicts).toEqual([
      {
        worktreeId: 'wt-shared',
        kept: { kind: 'environment', environmentId: ENV_A },
        others: [{ kind: 'local' }],
        fields: ['path', 'isArchived']
      }
    ])
  })

  it('keeps the local profile as the owner of a locally-owned workspace', () => {
    const local = record('local', [
      binding({ worktreeId: 'wt-local', hostId: 'local', isArchived: false })
    ])
    const remote = record('runtime:env-a', [
      binding({ worktreeId: 'wt-local', hostId: 'local', isArchived: true })
    ])

    const sources = mergeTaskRecordSources({ local, answers: [answered(ENV_A, remote)] })

    expect(sources.record?.bindings[0].isArchived).toBe(false)
    expect(sources.conflicts[0].kept).toEqual({ kind: 'local' })
    expect(sources.conflicts[0].fields).toEqual(['isArchived'])
  })

  it('names the tie-break when neither profile owns the workspace it states', () => {
    const local = record('local', [binding({ worktreeId: 'wt-ssh', hostId: 'ssh:box-1' })])
    const remote = record('runtime:env-a', [binding({ worktreeId: 'wt-ssh', hostId: 'ssh:box-1' })])

    const sources = mergeTaskRecordSources({ local, answers: [answered(ENV_A, remote)] })

    expect(sources.conflicts[0].kept).toEqual({ kind: 'local' })
    expect(sources.conflicts[0].fields).toEqual(['hostId'])
  })

  it('keeps a measured settlement the owning profile does not have', () => {
    const local = record('local', [
      binding({
        worktreeId: 'wt-shared',
        hostId: 'runtime:env-a',
        sessions: []
      })
    ])
    const remote = record('runtime:env-a', [
      {
        ...binding({ worktreeId: 'wt-shared', hostId: 'runtime:env-a' }),
        usageSettlement: {
          kind: 'known',
          collectedAt: 4,
          scope: 'worktree-rollup',
          worktreeId: 'wt-shared',
          providers: [{ provider: 'claude', tokens: 1200, costUsd: 0.5 }],
          estimatedCostUsd: 0.5
        }
      }
    ])

    const sources = mergeTaskRecordSources({ local, answers: [answered(ENV_A, remote)] })

    expect(sources.record?.bindings[0].usageSettlement).toMatchObject({ kind: 'known' })
  })

  it('refuses the other profile rows past the run cap and says so', () => {
    // The environment owns `runtime:env-a`, so its 16 rows are the owner's; the
    // local profile's one extra row cannot fit under the cap.
    const ownerRuns = Array.from({ length: 16 }, (_unused, index) => run(`own-${index}`))
    const local = record('local', [
      binding({ worktreeId: 'wt-shared', hostId: 'runtime:env-a', runs: [run('extra')] })
    ])
    const remote = record('runtime:env-a', [
      binding({ worktreeId: 'wt-shared', hostId: 'runtime:env-a', runs: ownerRuns })
    ])

    const sources = mergeTaskRecordSources({ local, answers: [answered(ENV_A, remote)] })

    // Refusal, not truncation: the owner's 16 rows stay whole and the reader is
    // told the other profile's rows did not fit.
    expect(sources.record?.bindings[0].runs).toHaveLength(16)
    expect(sources.conflicts[0].fields).toEqual(['runs-over-cap'])
  })
})

describe('classifyTaskRecordsRemoteFailure', () => {
  const failure = (code: string): RuntimeRpcCallError =>
    new RuntimeRpcCallError({
      ok: false,
      id: 'req-1',
      error: { code, message: `failed: ${code}` },
      _meta: { runtimeId: 'test-runtime' }
    })

  it('reads an old runtime as a version gap, not as missing history', () => {
    expect(classifyTaskRecordsRemoteFailure(failure('method_not_found'))).toBe('unsupported')
  })

  it('separates a scope refusal from a transport failure', () => {
    expect(classifyTaskRecordsRemoteFailure(failure('forbidden'))).toBe('forbidden')
    expect(classifyTaskRecordsRemoteFailure(failure('unauthorized'))).toBe('forbidden')
    expect(classifyTaskRecordsRemoteFailure(failure('runtime_busy'))).toBe('unreachable')
  })

  it('treats an out-of-window host as unsupported and anything unknown as retryable', () => {
    const blocked = new Error('This server is too old for this client')
    ;(blocked as { code?: string }).code = RUNTIME_COMPAT_BLOCK_CODE
    expect(classifyTaskRecordsRemoteFailure(blocked)).toBe('unsupported')

    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(classifyTaskRecordsRemoteFailure(abort)).toBe('unreachable')
    expect(classifyTaskRecordsRemoteFailure('socket hang up')).toBe('unreachable')
  })
})

describe('projectTaskRecordSource', () => {
  const sources = mergeTaskRecordSources({
    local: record('local', [binding({ worktreeId: 'wt-local', hostId: 'local' })]),
    answers: [
      {
        target: { kind: 'environment', environmentId: ENV_A },
        kind: 'unavailable',
        failure: 'unsupported'
      }
    ]
  })

  it('says nothing when no environment applies to this task', () => {
    expect(
      projectTaskRecordSource({
        environmentIds: [],
        candidateVerdict: 'not-needed',
        blocksFinalAbsence: false,
        sources,
        pending: false
      })
    ).toBeUndefined()
  })

  it('names the environment, its version and the reason', () => {
    expect(
      projectTaskRecordSource({
        environmentIds: [ENV_A],
        candidateVerdict: 'resolved',
        blocksFinalAbsence: false,
        sources,
        pending: false,
        labels: new Map([[ENV_A, 'Build box']]),
        appVersions: new Map([[ENV_A, '0.1.0+9d05e51df904']])
      })
    ).toEqual({
      environmentIds: [ENV_A],
      // The local profile is not an environment, so it is not listed as one — the
      // panel's `included` count is about the environments folded in.
      answered: [],
      unavailable: [
        {
          environmentId: ENV_A,
          failure: 'unsupported',
          label: 'Build box',
          appVersion: '0.1.0+9d05e51df904'
        }
      ],
      conflicts: [],
      pending: false
    })
  })

  it('drops the version for reasons where it is not the actionable fact', () => {
    const unreachable = mergeTaskRecordSources({
      local: null,
      answers: [
        {
          target: { kind: 'environment', environmentId: ENV_A },
          kind: 'unavailable',
          failure: 'unreachable'
        }
      ]
    })
    const projected = projectTaskRecordSource({
      environmentIds: [ENV_A],
      candidateVerdict: 'resolved',
      blocksFinalAbsence: false,
      sources: unreachable,
      pending: true,
      appVersions: new Map([[ENV_A, '1.4.219']])
    })
    expect(projected?.unavailable).toEqual([{ environmentId: ENV_A, failure: 'unreachable' }])
    expect(projected?.pending).toBe(true)
  })

  it('projects an undetermined candidate even when no environment could be named', () => {
    expect(
      projectTaskRecordSource({
        environmentIds: [],
        candidateVerdict: 'undetermined',
        blocksFinalAbsence: true,
        sources: mergeTaskRecordSources({ local: null, answers: [] }),
        pending: false
      })
    ).toMatchObject({
      environmentIds: [],
      candidateFailure: 'undetermined',
      blocksFinalAbsence: true,
      pending: false
    })
  })

  it('does not emit a global no-guess verdict when local absence remains final', () => {
    const projected = projectTaskRecordSource({
      environmentIds: [ENV_A],
      candidateVerdict: 'undetermined',
      blocksFinalAbsence: false,
      sources: mergeTaskRecordSources({ local: null, answers: [] }),
      pending: false
    })

    expect(projected?.candidateFailure).toBeUndefined()
  })
})
