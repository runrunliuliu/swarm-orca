// M4: the intent must exist before the side effect, and a stale intent must read as
// needs_reconciliation instead of silently disappearing. Filesystem only — no Git involved.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  beginSparseTaskCreate,
  readSparseTaskCreates,
  readUnsettledSparseTaskCreates,
  settleSparseTaskCreate
} from './sparse-task-create-journal'

const PINNED = 'a'.repeat(40)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-sparse-journal-'))
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

async function records(): Promise<unknown[]> {
  const file = join(dir, 'repo-1.json')
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { records: unknown[] }
  return parsed.records
}

describe('sparse task create journal', () => {
  it('records the intent as pending before anything else happens', async () => {
    const record = await beginSparseTaskCreate(intent)

    expect(record.state).toBe('pending')
    expect(record.pinnedSha).toBe(PINNED)
    expect(await records()).toHaveLength(1)
    expect((await readSparseTaskCreates('repo-1'))[0]).toMatchObject({
      requestId: record.requestId,
      state: 'pending',
      requestedSparseCone: ['swarm'],
      requiredPaths: ['AGENTS.md']
    })
  })

  it('settles one attempt without touching the others', async () => {
    const first = await beginSparseTaskCreate(intent)
    const second = await beginSparseTaskCreate({ ...intent, worktreePath: '/repo-wt-2' })

    await settleSparseTaskCreate({ repoId: 'repo-1', requestId: first.requestId, state: 'created' })
    await settleSparseTaskCreate({
      repoId: 'repo-1',
      requestId: second.requestId,
      state: 'needs_reconciliation',
      reasons: ['workspace kept for inspection']
    })

    const byId = Object.fromEntries(
      (await readSparseTaskCreates('repo-1')).map((record) => [record.requestId, record])
    )
    expect(byId[first.requestId]?.state).toBe('created')
    expect(byId[second.requestId]).toMatchObject({
      state: 'needs_reconciliation',
      reasons: ['workspace kept for inspection']
    })
  })

  it('lists only what still needs a human, and reports a stale pending as such', async () => {
    const settled = await beginSparseTaskCreate(intent)
    await settleSparseTaskCreate({ repoId: 'repo-1', requestId: settled.requestId, state: 'failed' })
    const inFlight = await beginSparseTaskCreate({ ...intent, worktreePath: '/repo-wt-live' })

    // Age the in-flight record past the staleness window without waiting for it: a create that
    // never settled must read as needing reconciliation, not as still running forever.
    const file = join(dir, 'repo-1.json')
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      version: number
      records: { requestId: string; updatedAt: number }[]
    }
    parsed.records = parsed.records.map((record) =>
      record.requestId === inFlight.requestId
        ? { ...record, updatedAt: Date.now() - 16 * 60_000 }
        : record
    )
    await writeFile(file, JSON.stringify(parsed))

    const unsettled = await readUnsettledSparseTaskCreates('repo-1')
    expect(unsettled).toHaveLength(1)
    expect(unsettled[0]).toMatchObject({ requestId: inFlight.requestId, state: 'needs_reconciliation' })
    expect(unsettled[0]?.reasons.join(' ')).toContain('never settled')
  })

  it('treats a missing or corrupt file as empty instead of failing every later create', async () => {
    expect(await readSparseTaskCreates('repo-unknown')).toEqual([])

    await writeFile(join(dir, 'repo-1.json'), '{not json')
    expect(await readSparseTaskCreates('repo-1')).toEqual([])
    // And it can still be appended to afterwards.
    await beginSparseTaskCreate(intent)
    expect(await readSparseTaskCreates('repo-1')).toHaveLength(1)
  })

  it('keeps the journal bounded and sanitizes the repo id into a file name', async () => {
    for (let index = 0; index < 55; index += 1) {
      await beginSparseTaskCreate({ ...intent, worktreePath: `/wt-${index}` })
    }
    const kept = await records()
    expect(kept).toHaveLength(50)
    expect((await readSparseTaskCreates('repo-1')).at(-1)).toMatchObject({ worktreePath: '/wt-54' })

    await beginSparseTaskCreate({ ...intent, repoId: '../evil/id' })
    // Why readdir: the point is that no path separator survives, not the exact replacement glyph.
    const names = (await readdir(dir)).filter((name) => name !== 'repo-1.json')
    expect(names).toHaveLength(1)
    expect(names[0]).not.toContain('/')
    expect(JSON.parse(await readFile(join(dir, names[0]!), 'utf8')).records).toHaveLength(1)
  })
})
