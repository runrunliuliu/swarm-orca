import { createHash } from 'node:crypto'
import { ensureActiveOrcaProfile } from '../../../../src/main/orca-profiles/profile-index-store'
import { ProfileStateSqliteAuthority } from '../../../../src/main/persistence/profile-state/profile-state-sqlite-authority'
import { normalizeExecutionHostId } from '../../../../src/shared/execution-host'
import {
  taskRecordRunClaimKey,
  EMPTY_TASK_RECORDS,
  type TaskRecordRun,
  type TaskRecordsState,
  type TaskUsageSettlement
} from '../../../../src/shared/task-records-types'
import { normalizeTaskRecords, taskRecordTaskId } from '../../../../src/shared/task-records'
import {
  mergeTaskRecordRuns,
  setTaskRecordBindingSettlement,
  upsertTaskRecordBinding,
  type TaskRecordsWriteResult
} from '../../../../src/shared/task-records-updates'
import { isTaskProvider } from '../../../../src/shared/task-providers'
import { splitWorktreeId } from '../../../../src/shared/worktree/id'
import type { SimRuntime } from './runtime-host'

export type SeededBinding = {
  worktreeId: string
  hostId: string
  isArchived: boolean
  runs: number
  usage?: 'unknown' | { tokens: number; costUsd: number }
}

type SeedTaskRecordArgs = {
  repoId: string
  itemType: 'issue' | 'pr'
  number: number
  provider?: string
  bindings: SeededBinding[]
}

function deterministicInstant(parts: readonly unknown[]): number {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return 1_700_000_000_000 + Number.parseInt(digest.slice(0, 8), 16)
}

function requireWrite(result: TaskRecordsWriteResult, action: string): TaskRecordsState {
  if (!result.ok) {
    throw new Error(`Task-record ${action} refused: ${result.reason}`)
  }
  if (result.skipped === 'missing_binding') {
    throw new Error(`Task-record ${action} skipped a missing binding`)
  }
  return result.state
}

function seededRuns(args: {
  taskId: string
  binding: SeededBinding
  count: number
}): TaskRecordRun[] {
  return Array.from({ length: args.count }, (_, index) => {
    const id = createHash('sha256')
      .update(
        `${args.taskId}\u0000${args.binding.worktreeId}\u0000${args.binding.hostId}\u0000${index}`
      )
      .digest('hex')
      .slice(0, 20)
    const providerSession = { provider: 'codex' as const, key: 'session_id', id }
    const observedAt = deterministicInstant([
      args.taskId,
      args.binding.worktreeId,
      args.binding.hostId,
      index
    ])
    return {
      key: taskRecordRunClaimKey(providerSession),
      providerSession,
      agentType: 'codex',
      title: `Simulated run ${index + 1}`,
      source: 'backfill',
      recordedAt: observedAt,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt
    }
  })
}

function seededSettlement(
  binding: SeededBinding,
  collectedAt: number
): TaskUsageSettlement | undefined {
  if (binding.usage === undefined) {
    return undefined
  }
  if (binding.usage === 'unknown') {
    return {
      kind: 'unavailable',
      collectedAt,
      scope: 'worktree-rollup',
      worktreeId: binding.worktreeId,
      reason: binding.hostId === 'local' ? 'no_matching_session' : 'remote_usage_unavailable'
    }
  }
  if (
    !Number.isFinite(binding.usage.tokens) ||
    binding.usage.tokens < 0 ||
    !Number.isFinite(binding.usage.costUsd) ||
    binding.usage.costUsd < 0
  ) {
    throw new Error(`Invalid known usage for ${binding.worktreeId}`)
  }
  return {
    kind: 'known',
    collectedAt,
    scope: 'worktree-rollup',
    worktreeId: binding.worktreeId,
    providers: [
      { provider: 'codex', tokens: binding.usage.tokens, costUsd: binding.usage.costUsd }
    ],
    estimatedCostUsd: binding.usage.costUsd
  }
}

function seedState(state: TaskRecordsState, args: SeedTaskRecordArgs): TaskRecordsState {
  const provider = args.provider ?? 'github'
  if (!isTaskProvider(provider)) {
    throw new Error(`Unsupported task provider: ${provider}`)
  }
  if (!args.repoId || !Number.isInteger(args.number) || args.bindings.length === 0) {
    throw new Error('A repo id, integer task number, and at least one binding are required')
  }
  const taskId = taskRecordTaskId({
    provider,
    repoId: args.repoId,
    itemType: args.itemType,
    number: args.number
  })
  let current = state
  for (const binding of args.bindings) {
    const hostId = normalizeExecutionHostId(binding.hostId)
    const parsed = splitWorktreeId(binding.worktreeId)
    if (!hostId) {
      throw new Error(`Invalid execution host id: ${binding.hostId}`)
    }
    if (!parsed || parsed.repoId !== args.repoId || !parsed.worktreePath) {
      throw new Error(`Worktree ${binding.worktreeId} does not belong to repo ${args.repoId}`)
    }
    if (!Number.isInteger(binding.runs) || binding.runs < 0) {
      throw new Error(`Invalid run count for ${binding.worktreeId}: ${binding.runs}`)
    }
    const boundAt = deterministicInstant([taskId, binding.worktreeId, hostId, 'binding'])
    current = requireWrite(
      upsertTaskRecordBinding(current, {
        taskId,
        hostId,
        repoId: args.repoId,
        worktreeId: binding.worktreeId,
        path: parsed.worktreePath,
        isArchived: binding.isArchived,
        origin: { kind: 'external', provider, itemType: args.itemType, number: args.number },
        now: boundAt,
        boundBy: 'reconciled'
      }),
      'binding upsert'
    )
    const runs = seededRuns({ taskId, binding, count: binding.runs })
    current = requireWrite(
      mergeTaskRecordRuns(current, {
        taskId,
        worktreeId: binding.worktreeId,
        hostId,
        runs,
        now: runs.at(-1)?.recordedAt ?? boundAt
      }),
      'run merge'
    )
    const settlement = seededSettlement(
      binding,
      deterministicInstant([taskId, binding.worktreeId, hostId, binding.usage ?? null])
    )
    if (settlement) {
      current = requireWrite(
        setTaskRecordBindingSettlement(current, {
          taskId,
          worktreeId: binding.worktreeId,
          hostId,
          settlement
        }),
        'usage settlement'
      )
    }
  }
  return current
}

async function withStoppedRuntime<T>(
  runtime: SimRuntime,
  operation: () => T | Promise<T>
): Promise<T> {
  await runtime.kill()
  const outcome = await Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
  try {
    await runtime.start()
  } catch (restartError) {
    if ('error' in outcome) {
      throw new AggregateError(
        [outcome.error, restartError],
        'Profile operation and runtime restart failed'
      )
    }
    throw restartError
  }
  if ('error' in outcome) {
    throw outcome.error
  }
  return outcome.value
}

export async function seedTaskRecord(
  runtime: SimRuntime,
  args: SeedTaskRecordArgs
): Promise<{ repoId: string; itemType: 'issue' | 'pr'; number: number }> {
  await withStoppedRuntime(runtime, () => {
    const profile = ensureActiveOrcaProfile(runtime.userDataDir)
    const authority = new ProfileStateSqliteAuthority(profile.stateDatabaseFile, profile.profile.id)
    try {
      const serialized = authority.readSerializedState()
      const root: unknown = serialized === undefined ? {} : JSON.parse(serialized)
      if (typeof root !== 'object' || root === null || Array.isArray(root)) {
        throw new Error('Runtime profile state is not an object')
      }
      const taskRecords = normalizeTaskRecords(Reflect.get(root, 'taskRecords'))
      if (!taskRecords.readable) {
        throw new Error('Runtime task-record domain is from an unsupported schema')
      }
      const seeded = seedState(taskRecords.state ?? EMPTY_TASK_RECORDS, args)
      if (JSON.stringify(seeded) === JSON.stringify(taskRecords.state)) {
        return
      }
      authority.writeSerializedDomains([{ domain: 'taskRecords', payload: JSON.stringify(seeded) }])
    } finally {
      authority.close()
    }
  })
  return { repoId: args.repoId, itemType: args.itemType, number: args.number }
}
