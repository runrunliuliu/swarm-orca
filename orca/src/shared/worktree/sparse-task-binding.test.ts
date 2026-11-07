// M5 (minimum): the persisted task binding must be reconstructible, tamper-evident and readable
// only when it is exactly the schema we wrote. Pure functions, no Git and no store.
import { describe, expect, it } from 'vitest'
import type { SparseTaskWorkspaceReceipt } from './create-types'
import {
  SPARSE_TASK_BINDING_SCHEMA_VERSION,
  createSparseTaskWorkspaceBinding,
  parseSparseTaskWorkspaceBinding,
  sparseTaskBindingDigest,
  sparseTaskBindingMatchesReceipt
} from './sparse-task-binding'

const PINNED = 'a'.repeat(40)

function receipt(overrides: Partial<SparseTaskWorkspaceReceipt> = {}): SparseTaskWorkspaceReceipt {
  return {
    baseSource: 'request',
    resolvedRef: 'refs/heads/main',
    pinnedSha: PINNED,
    actualHead: PINNED,
    requestedSparseCone: ['swarm', 'swarm/skills'],
    effectiveSparseCone: ['swarm'],
    requiredPaths: ['AGENTS.md', 'swarm/skills/SKILL.md'],
    ...overrides
  }
}

describe('createSparseTaskWorkspaceBinding', () => {
  it('keeps the facts a later reader cannot re-read, and drops the snapshot state', () => {
    const binding = createSparseTaskWorkspaceBinding(receipt(), 1_700_000_000_000)

    expect(binding).toMatchObject({
      schemaVersion: SPARSE_TASK_BINDING_SCHEMA_VERSION,
      mode: 'task-workspace-v1',
      pinnedSha: PINNED,
      baseSource: 'request',
      resolvedRef: 'refs/heads/main',
      requestedSparseCone: ['swarm', 'swarm/skills'],
      requiredPaths: ['AGENTS.md', 'swarm/skills/SKILL.md'],
      createdAt: 1_700_000_000_000
    })
    // Why: HEAD and the effective cone are read back from the workspace, so a stored copy would
    // only ever be a stale claim.
    expect(binding).not.toHaveProperty('actualHead')
    expect(binding).not.toHaveProperty('effectiveSparseCone')
    expect(binding.bindingDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('digests the canonical fields, not the insertion order of a caller-built object', () => {
    const binding = createSparseTaskWorkspaceBinding(receipt(), 123)
    const fields = {
      createdAt: 123,
      requiredPaths: ['AGENTS.md', 'swarm/skills/SKILL.md'],
      requestedSparseCone: ['swarm', 'swarm/skills'],
      resolvedRef: 'refs/heads/main',
      baseSource: 'request' as const,
      pinnedSha: PINNED,
      mode: 'task-workspace-v1' as const,
      schemaVersion: SPARSE_TASK_BINDING_SCHEMA_VERSION
    }

    expect(sparseTaskBindingDigest(fields)).toBe(binding.bindingDigest)
  })

  it('produces a different digest when any covered field changes', () => {
    const base = createSparseTaskWorkspaceBinding(receipt(), 123)
    const changed = createSparseTaskWorkspaceBinding(
      receipt({ pinnedSha: 'b'.repeat(40) }),
      123
    )
    const later = createSparseTaskWorkspaceBinding(receipt(), 124)

    expect(changed.bindingDigest).not.toBe(base.bindingDigest)
    expect(later.bindingDigest).not.toBe(base.bindingDigest)
  })

  it('normalizes the pinned sha to lowercase', () => {
    const binding = createSparseTaskWorkspaceBinding(receipt({ pinnedSha: PINNED.toUpperCase() }), 1)
    expect(binding.pinnedSha).toBe(PINNED)
  })
})

describe('parseSparseTaskWorkspaceBinding', () => {
  const valid = createSparseTaskWorkspaceBinding(receipt(), 1_700_000_000_000)

  it('round-trips a record it produced itself', () => {
    expect(parseSparseTaskWorkspaceBinding(structuredClone(valid))).toEqual(valid)
  })

  it('rejects anything whose digest no longer matches its fields', () => {
    const tampered = { ...valid, requestedSparseCone: ['orca'] }
    expect(parseSparseTaskWorkspaceBinding(tampered)).toBeNull()
    expect(parseSparseTaskWorkspaceBinding({ ...valid, createdAt: valid.createdAt + 1 })).toBeNull()
  })

  it('rejects a record that is not exactly this schema', () => {
    // Why exact keys: a record written by a future build must not be read as v1 and then enforced.
    expect(parseSparseTaskWorkspaceBinding({ ...valid, extra: true })).toBeNull()
    const { requiredPaths: _dropped, ...missing } = valid
    expect(parseSparseTaskWorkspaceBinding(missing)).toBeNull()
    expect(parseSparseTaskWorkspaceBinding({ ...valid, schemaVersion: 2 })).toBeNull()
    expect(parseSparseTaskWorkspaceBinding({ ...valid, mode: 'legacy-sparse' })).toBeNull()
  })

  it('rejects malformed field values instead of coercing them', () => {
    const withDigest = (fields: Record<string, unknown>) => ({
      ...valid,
      ...fields,
      bindingDigest: valid.bindingDigest
    })

    expect(parseSparseTaskWorkspaceBinding(null)).toBeNull()
    expect(parseSparseTaskWorkspaceBinding([])).toBeNull()
    expect(parseSparseTaskWorkspaceBinding('binding')).toBeNull()
    expect(parseSparseTaskWorkspaceBinding(withDigest({ pinnedSha: 'not-a-sha' }))).toBeNull()
    expect(parseSparseTaskWorkspaceBinding(withDigest({ baseSource: 'guess' }))).toBeNull()
    expect(parseSparseTaskWorkspaceBinding(withDigest({ resolvedRef: '' }))).toBeNull()
    expect(parseSparseTaskWorkspaceBinding(withDigest({ requestedSparseCone: 'swarm' }))).toBeNull()
    expect(parseSparseTaskWorkspaceBinding(withDigest({ requiredPaths: [1] }))).toBeNull()
    expect(parseSparseTaskWorkspaceBinding(withDigest({ createdAt: Number.NaN }))).toBeNull()
  })
})

describe('sparseTaskBindingMatchesReceipt', () => {
  const binding = createSparseTaskWorkspaceBinding(receipt(), 1)

  it('accepts the receipt the binding was made from', () => {
    expect(sparseTaskBindingMatchesReceipt(binding, receipt())).toBe(true)
  })

  it('rejects a receipt about a different baseline or different declarations', () => {
    expect(
      sparseTaskBindingMatchesReceipt(binding, receipt({ pinnedSha: 'b'.repeat(40) }))
    ).toBe(false)
    expect(
      sparseTaskBindingMatchesReceipt(binding, receipt({ requestedSparseCone: ['swarm/skills'] }))
    ).toBe(false)
    expect(sparseTaskBindingMatchesReceipt(binding, receipt({ requiredPaths: [] }))).toBe(false)
    expect(
      sparseTaskBindingMatchesReceipt(binding, receipt({ baseSource: 'default' }))
    ).toBe(false)
  })

  it('ignores the receipt-only fields the binding never stored', () => {
    expect(
      sparseTaskBindingMatchesReceipt(binding, receipt({ actualHead: 'c'.repeat(40), effectiveSparseCone: [] }))
    ).toBe(true)
  })
})
