// M4: at process start, every `pending` create from a previous process is observed once — and only
// observed. The cases below are about what the sweep must refuse to touch.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SparseTaskCreateInspection } from './sparse-task-create-reconciliation'
import {
  beginSparseTaskCreate,
  readSparseTaskCreates,
  settleSparseTaskCreate
} from './sparse-task-create-journal'
import { sweepTaskCreateJournalOnStart } from './sparse-task-create-startup-sweep'

const PINNED = 'a'.repeat(40)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-sweep-'))
  process.env.ORCA_SPARSE_TASK_JOURNAL_DIR = dir
})

afterEach(async () => {
  delete process.env.ORCA_SPARSE_TASK_JOURNAL_DIR
  await rm(dir, { recursive: true, force: true })
})

const intent = {
  repoId: 'repo-1',
  repoPath: '/repo',
  worktreePath: '/repo-wt',
  branch: 'task',
  pinnedSha: PINNED,
  requestedSparseCone: ['swarm'],
  requiredPaths: ['AGENTS.md']
}

const inspection = (state: SparseTaskCreateInspection['state']): SparseTaskCreateInspection => ({
  state,
  worktreePath: '/repo-wt',
  branch: 'task',
  pinnedSha: PINNED,
  registered: state !== 'absent',
  ghostRegistration: false,
  directoryExists: state !== 'absent',
  reasons: state === 'partial' ? ['registered but the directory is missing'] : []
})

describe('sweepTaskCreateJournalOnStart', () => {
  it('classifies attempts recorded before this process started', async () => {
    const live = await beginSparseTaskCreate(intent)
    const gone = await beginSparseTaskCreate({ ...intent, worktreePath: '/repo-wt-2' })
    const partial = await beginSparseTaskCreate({ ...intent, worktreePath: '/repo-wt-3' })
    const states: Record<string, SparseTaskCreateInspection['state']> = {
      '/repo-wt': 'live',
      '/repo-wt-2': 'absent',
      '/repo-wt-3': 'partial'
    }

    const result = await sweepTaskCreateJournalOnStart({
      startedBefore: Date.now() + 1_000,
      inspector: vi.fn(async ({ worktreePath }: { worktreePath: string }) =>
        inspection(states[worktreePath]!)
      )
    })

    expect(result).toMatchObject({ inspected: 3, failed: 0, skippedInFlight: 0 })
    const byId = Object.fromEntries(
      (await readSparseTaskCreates('repo-1')).map((record) => [record.requestId, record])
    )
    expect(byId[live.requestId]?.observation?.state).toBe('live')
    expect(byId[gone.requestId]?.observation?.state).toBe('exited')
    expect(byId[partial.requestId]?.observation?.state).toBe('unverifiable')
    // Why still pending: the sweep observed, it did not decide the create is finished.
    expect(byId[partial.requestId]?.state).toBe('pending')
  })

  it('leaves a settled attempt alone and skips one that may still be in flight', async () => {
    const settled = await beginSparseTaskCreate(intent)
    await settleSparseTaskCreate({ repoId: 'repo-1', requestId: settled.requestId, state: 'created' })
    const fresh = await beginSparseTaskCreate({ ...intent, worktreePath: '/repo-wt-fresh' })
    const inspector = vi.fn(async () => inspection('live'))

    const result = await sweepTaskCreateJournalOnStart({
      // Everything is newer than this cutoff, which is what a still-running create looks like.
      startedBefore: 0,
      inspector
    })

    expect(result).toMatchObject({ inspected: 0, skippedInFlight: 1 })
    expect(inspector).not.toHaveBeenCalled()
    const stored = (await readSparseTaskCreates('repo-1')).find(
      (record) => record.requestId === fresh.requestId
    )
    expect(stored?.observation).toBeUndefined()
  })

  it('keeps going when one probe fails, and does not throw', async () => {
    const broken = await beginSparseTaskCreate(intent)
    const fine = await beginSparseTaskCreate({ ...intent, worktreePath: '/repo-wt-ok' })
    const inspector = vi.fn(async ({ worktreePath }: { worktreePath: string }) => {
      if (worktreePath === '/repo-wt') {
        throw new Error('git unavailable')
      }
      return inspection('absent')
    })

    const result = await sweepTaskCreateJournalOnStart({
      startedBefore: Date.now() + 1_000,
      inspector
    })

    expect(result).toMatchObject({ inspected: 1, failed: 1 })
    const byId = Object.fromEntries(
      (await readSparseTaskCreates('repo-1')).map((record) => [record.requestId, record])
    )
    // The failed one stays pending so the next start retries it; the other is annotated.
    expect(byId[broken.requestId]?.observation).toBeUndefined()
    expect(byId[fine.requestId]?.observation?.state).toBe('exited')
  })

  it('is bounded, so a first start on a busy host stays cheap', async () => {
    for (let index = 0; index < 5; index += 1) {
      await beginSparseTaskCreate({ ...intent, worktreePath: `/wt-${index}` })
    }
    const inspector = vi.fn(async () => inspection('absent'))

    const result = await sweepTaskCreateJournalOnStart({
      startedBefore: Date.now() + 1_000,
      inspector,
      limit: 2
    })

    expect(result.inspected).toBe(2)
    expect(inspector).toHaveBeenCalledTimes(2)
  })
})
