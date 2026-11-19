import { describe, expect, it } from 'vitest'
import { taskRecordTaskId } from '../../../shared/task-records'
import { normalizeTaskRunHistory } from '../../../shared/task-run-history'
import { migrateTaskRecordsFromRunHistory } from './task-records-legacy-migration'

const DELETED = {
  repoId: 'repo-1',
  itemType: 'issue' as const,
  number: 31,
  worktreeId: 'repo-1::/repo/feature',
  path: '/repo/feature',
  state: 'deleted' as const,
  firstSeenAt: 100,
  updatedAt: 200,
  deletedAt: 200
}

describe('task records ↔ legacy ledger migration', () => {
  it('seeds one record from a deleted ledger row', () => {
    const state = migrateTaskRecordsFromRunHistory({ version: 1, records: [DELETED] })

    const taskId = taskRecordTaskId({
      provider: 'github',
      repoId: 'repo-1',
      itemType: 'issue',
      number: 31
    })
    expect(state?.byId[taskId]).toMatchObject({
      taskId,
      createdAt: 100,
      updatedAt: 200,
      bindings: [expect.objectContaining({ worktreeId: 'repo-1::/repo/feature' })]
    })
  })

  it('migrates a deleted row as unverified, so the panel says unresolved', () => {
    const state = migrateTaskRecordsFromRunHistory({ version: 1, records: [DELETED] })
    const binding = Object.values(state?.byId ?? {})[0]?.bindings[0]

    expect(binding?.lastVerifiedAt).toBeNull()
    expect(binding?.resolvedVia).toBeUndefined()
  })

  it('keeps an archived row archived and verified at its last update', () => {
    const state = migrateTaskRecordsFromRunHistory({
      version: 1,
      records: [{ ...DELETED, state: 'archived', archivedAt: 150 }]
    })
    const binding = Object.values(state?.byId ?? {})[0]?.bindings[0]

    expect(binding).toMatchObject({ isArchived: true, lastVerifiedAt: 200, resolvedVia: 'locator' })
  })

  it('survives a ledger with null rows, because normalization runs first', () => {
    // The raw stored value is untrusted JSON; the load path normalizes before
    // migrating so a corrupt row cannot fail the whole profile load.
    const ledger = normalizeTaskRunHistory({
      version: 1,
      records: [null, DELETED, 'nope']
    })

    const state = migrateTaskRecordsFromRunHistory(ledger)
    expect(Object.values(state?.byId ?? {})).toHaveLength(1)
  })

  it('returns nothing for a payload that is not a ledger at all', () => {
    expect(migrateTaskRecordsFromRunHistory(normalizeTaskRunHistory({}))).toBeUndefined()
    expect(migrateTaskRecordsFromRunHistory(normalizeTaskRunHistory(null))).toBeUndefined()
  })

  it('returns nothing for an absent or empty ledger', () => {
    expect(migrateTaskRecordsFromRunHistory(undefined)).toBeUndefined()
    expect(migrateTaskRecordsFromRunHistory({ version: 1, records: [] })).toBeUndefined()
  })
})
