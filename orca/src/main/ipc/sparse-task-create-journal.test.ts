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
  recordSparseTaskCreateObservation,
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

async function recordFiles(repo = 'repo-1'): Promise<string[]> {
  try {
    return (await readdir(join(dir, repo))).filter((name) => name.endsWith('.json'))
  } catch {
    // No directory yet is the same answer as no records.
    return []
  }
}

describe('sparse task create journal', () => {
  it('records the intent as pending before anything else happens', async () => {
    const record = await beginSparseTaskCreate(intent)

    expect(record.state).toBe('pending')
    expect(record.pinnedSha).toBe(PINNED)
    expect(await recordFiles()).toHaveLength(1)
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
    const file = join(dir, 'repo-1', `${inFlight.requestId}.json`)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { updatedAt: number }
    await writeFile(file, JSON.stringify({ ...parsed, updatedAt: Date.now() - 16 * 60_000 }))

    const unsettled = await readUnsettledSparseTaskCreates('repo-1')
    expect(unsettled).toHaveLength(1)
    expect(unsettled[0]).toMatchObject({ requestId: inFlight.requestId, state: 'needs_reconciliation' })
    expect(unsettled[0]?.reasons.join(' ')).toContain('never settled')
  })

  it('skips an unreadable record instead of failing every later create', async () => {
    expect(await readSparseTaskCreates('repo-unknown')).toEqual([])

    const broken = await beginSparseTaskCreate(intent)
    await writeFile(join(dir, 'repo-1', `${broken.requestId}.json`), '{not json')
    expect(await readSparseTaskCreates('repo-1')).toEqual([])
    // The unreadable file stays where it is; a later attempt is still recorded beside it.
    await beginSparseTaskCreate({ ...intent, worktreePath: '/wt-later' })
    expect(await readSparseTaskCreates('repo-1')).toHaveLength(1)
  })

  it('keeps two concurrent intents that start at the same time', async () => {
    // Why this is the important case: a per-repo file would read-merge-write here and the later
    // writer would erase the earlier `pending`, leaving a create running with no trace.
    const [first, second] = await Promise.all([
      beginSparseTaskCreate({ ...intent, worktreePath: '/wt-a' }),
      beginSparseTaskCreate({ ...intent, worktreePath: '/wt-b' })
    ])
    await settleSparseTaskCreate({ repoId: 'repo-1', requestId: first.requestId, state: 'created' })

    const records = await readSparseTaskCreates('repo-1')
    expect(records.map((record) => record.worktreePath).sort()).toEqual(['/wt-a', '/wt-b'])
    expect(records.find((record) => record.requestId === second.requestId)?.state).toBe('pending')
  })

  it('keeps the journal bounded by dropping old settled attempts, never an unsettled one', async () => {
    for (let index = 0; index < 55; index += 1) {
      const record = await beginSparseTaskCreate({ ...intent, worktreePath: `/wt-${index}` })
      if (index < 52) {
        await settleSparseTaskCreate({ repoId: 'repo-1', requestId: record.requestId, state: 'created' })
      }
    }
    const kept = await readSparseTaskCreates('repo-1')
    // Why the three unsettled ones survive a cap of 50: an attempt that may still be running is the
    // one record a human must be able to find, so the cap applies to settled history only.
    expect(kept).toHaveLength(50)
    expect(kept.filter((record) => record.state === 'pending')).toHaveLength(3)
    expect(kept.at(-1)).toMatchObject({ worktreePath: '/wt-54' })

    await beginSparseTaskCreate({ ...intent, repoId: '../evil/id' })
    // Why readdir: the point is that no path separator survives, not the exact replacement glyph.
    const names = (await readdir(dir)).filter((name) => name !== 'repo-1')
    expect(names).toHaveLength(1)
    expect(names[0]).not.toContain('/')
    expect(await recordFiles(names[0]!)).toHaveLength(1)
  })
})

// Restart reconciliation: a later reader records what it saw, and that annotation must never be
// mistaken for the attempt settling.
describe('recordSparseTaskCreateObservation', () => {
  it('annotates the attempt without changing its recorded state', async () => {
    const record = await beginSparseTaskCreate(intent)

    await recordSparseTaskCreateObservation({
      repoId: 'repo-1',
      requestId: record.requestId,
      observation: { state: 'exited', at: 42, reasons: ['nothing on disk'] }
    })

    const [stored] = await readSparseTaskCreates('repo-1')
    expect(stored?.state).toBe('pending')
    expect(stored?.observation).toEqual({
      state: 'exited',
      at: 42,
      reasons: ['nothing on disk']
    })
    // Still unsettled: an observation is evidence, not a decision.
    expect(await readUnsettledSparseTaskCreates('repo-1')).toHaveLength(1)
  })

  it('does nothing for an attempt that was never recorded', async () => {
    await recordSparseTaskCreateObservation({
      repoId: 'repo-1',
      requestId: 'never-existed',
      observation: { state: 'live', at: 1, reasons: [] }
    })

    expect(await recordFiles()).toHaveLength(0)
  })
})

describe('concurrent settle and annotation', () => {
  it('does not let an annotation revert a settle that landed beside it', async () => {
    const record = await beginSparseTaskCreate(intent)

    // Why in parallel: this is the actual race — a status query annotating while the create settles.
    await Promise.all([
      settleSparseTaskCreate({ repoId: 'repo-1', requestId: record.requestId, state: 'created' }),
      recordSparseTaskCreateObservation({
        repoId: 'repo-1',
        requestId: record.requestId,
        observation: { state: 'live', at: 7, reasons: [] }
      })
    ])

    const [stored] = await readSparseTaskCreates('repo-1')
    expect(stored?.state).toBe('created')
    expect(stored?.observation?.state).toBe('live')
  })
})
