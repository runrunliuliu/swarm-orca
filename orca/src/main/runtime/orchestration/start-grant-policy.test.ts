import { describe, expect, it } from 'vitest'
import { hashCanonical } from '../rpc/orchestration-mutation-receipt'
import {
  objectiveHashOf,
  readGrantForRun,
  startGrantBindingSchema,
  startGrantRevocationSchema,
  startGrantSchema,
  type StartGrant
} from './start-grant-policy'

const minter = {
  terminalHandle: 'term_minter',
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  processIncarnation: 'pty:1',
  launchTokenHash: 'launch-hash',
  hostScope: { kind: 'local', hostId: 'local' }
} as const

const objectiveText = 'review the parser, read only'

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'start_grant',
    grantId: '2f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d21',
    objectiveText,
    objectiveHash: objectiveHashOf(objectiveText),
    taskSource: { path: '/tmp/approval.md', sha256: 'a'.repeat(64) },
    authorizationRefs: [],
    maxWorkers: 8,
    repos: [{ repoId: 'repo-1', worktreeIds: null }],
    writableRoots: [],
    spend: { kind: 'none' },
    deadline: '2026-11-14T00:00:00.000Z',
    minter,
    mintedAt: '2026-11-13T00:00:00.000Z',
    executionAuthorized: false,
    ...overrides
  }
}

function issuePaths(input: Record<string, unknown>): string[] {
  const parsed = startGrantSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))
}

/** Whether the record is refused at (or inside) `field`, without pinning zod's exact leaf path. */
function rejectedAt(input: Record<string, unknown>, field: string): boolean {
  return issuePaths(input).some((path) => path === field || path.startsWith(`${field}.`))
}

describe('start grant record', () => {
  it('accepts the documented shape and survives a JSON round trip unchanged', () => {
    const parsed = startGrantSchema.parse(valid())
    expect(startGrantSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    expect(parsed.maxWorkers).toBe(8)
    expect(parsed.executionAuthorized).toBe(false)
  })

  it('requires every field the contract calls mandatory', () => {
    for (const field of [
      'grantId',
      'objectiveText',
      'objectiveHash',
      'taskSource',
      'maxWorkers',
      'repos',
      'writableRoots',
      'spend',
      'deadline',
      'minter',
      'mintedAt',
      'executionAuthorized'
    ]) {
      const input = valid()
      delete input[field]
      expect(rejectedAt(input, field), field).toBe(true)
    }
  })

  it('rejects the arithmetic that would make a grant useless or a lie', () => {
    expect(rejectedAt(valid({ maxWorkers: 0 }), 'maxWorkers')).toBe(true)
    expect(rejectedAt(valid({ maxWorkers: 1.5 }), 'maxWorkers')).toBe(true)
    expect(issuePaths(valid({ maxWorkers: 1 }))).toEqual([])
    expect(rejectedAt(valid({ deadline: '2026-11-13T00:00:00.000Z' }), 'deadline')).toBe(true)
    expect(rejectedAt(valid({ deadline: '2026-11-12T00:00:00.000Z' }), 'deadline')).toBe(true)
    expect(issuePaths(valid({ deadline: '2026-11-14T00:00:00Z' }))).toEqual([])
    expect(rejectedAt(valid({ deadline: '2026-11-14' }), 'deadline')).toBe(true)
  })

  it('refuses an objective hash that is not the hash of its own text', () => {
    expect(rejectedAt(valid({ objectiveHash: 'b'.repeat(64) }), 'objectiveHash')).toBe(true)
    expect(
      rejectedAt(valid({ objectiveHash: objectiveHashOf(`${objectiveText} `) }), 'objectiveHash')
    ).toBe(true)
  })

  it('keeps the hash definition shared with the Run create path', () => {
    // `createRun` compares exactly this value, so pin the equality rather than the implementation.
    expect(objectiveHashOf(objectiveText)).toBe(hashCanonical(objectiveText))
    expect(objectiveHashOf('a')).not.toBe(objectiveHashOf('a '))
  })

  it('accepts only absolute canonical writable roots', () => {
    for (const roots of [['relative/dir'], ['/tmp/../etc'], ['/tmp/dir/'], ['/']]) {
      expect(rejectedAt(valid({ writableRoots: roots }), 'writableRoots'), String(roots)).toBe(true)
    }
    expect(issuePaths(valid({ writableRoots: ['/tmp/scratch', '/tmp/other'] }))).toEqual([])
  })

  it('keeps repo scope unambiguous: unique repos, unique worktrees, null means the whole repo', () => {
    expect(rejectedAt(valid({ repos: [] }), 'repos')).toBe(true)
    expect(
      rejectedAt(
        valid({
          repos: [
            { repoId: 'repo-1', worktreeIds: null },
            { repoId: 'repo-1', worktreeIds: ['wt-1'] }
          ]
        }),
        'repos'
      )
    ).toBe(true)
    expect(
      issuePaths(valid({ repos: [{ repoId: 'repo-1', worktreeIds: ['wt-1', 'wt-1'] }] }))
    ).toContain('repos.0.worktreeIds')
    expect(
      issuePaths(valid({ repos: [{ repoId: 'repo-1', worktreeIds: [] }] }))
    ).toContain('repos.0.worktreeIds')
  })

  it('records spend as a declared choice, not a free-form number', () => {
    expect(issuePaths(valid({ spend: { kind: 'none' } }))).toEqual([])
    expect(issuePaths(valid({ spend: { kind: 'capped', limitUsd: 5 } }))).toEqual([])
    expect(rejectedAt(valid({ spend: { kind: 'capped', limitUsd: 0 } }), 'spend')).toBe(true)
    expect(rejectedAt(valid({ spend: { kind: 'unlimited' } }), 'spend')).toBe(true)
  })

  it('requires a complete live minter identity, not a handle alone', () => {
    expect(rejectedAt(valid({ minter: { terminalHandle: 'term_minter' } }), 'minter')).toBe(true)
    expect(
      rejectedAt(valid({ minter: { ...minter, processIncarnation: '' } }), 'minter')
    ).toBe(true)
  })

  it('refuses a record that claims execution authority', () => {
    expect(rejectedAt(valid({ executionAuthorized: true }), 'executionAuthorized')).toBe(true)
  })

  it('keeps a revocation and a binding insert-only in shape', () => {
    const revocation = {
      schemaVersion: 1,
      kind: 'start_grant_revocation',
      grantId: '2f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d21',
      revokedAt: '2026-11-13T01:00:00.000Z',
      authority: minter,
      reason: 'owner withdrew the approval',
      executionAuthorized: false
    }
    expect(startGrantRevocationSchema.safeParse(revocation).success).toBe(true)
    expect(startGrantRevocationSchema.safeParse({ ...revocation, reason: '' }).success).toBe(false)
    expect(
      startGrantRevocationSchema.safeParse({ ...revocation, executionAuthorized: true }).success
    ).toBe(false)

    const binding = {
      grantId: revocation.grantId,
      runId: 'run_1',
      boundAt: '2026-11-13T01:00:00.000Z',
      boundAuthority: minter
    }
    expect(startGrantBindingSchema.safeParse(binding).success).toBe(true)
    expect(startGrantBindingSchema.safeParse({ ...binding, grantId: 'not-a-uuid' }).success).toBe(
      false
    )
  })

  it('reads a binding without its grant as invalid, never as "this Run has no grant"', () => {
    // The foreign key makes this state unreachable through the writers, but the reader must not depend
    // on a driver behaviour: `undefined` here would mean "spawn is uncapped", which is the fail-open
    // case. A staged row set pins the branch without needing a database that violates its own keys.
    const binding = {
      grant_id: '11111111-2222-4333-8444-555555555555',
      run_id: 'run_1',
      receipt: JSON.stringify({
        grantId: '11111111-2222-4333-8444-555555555555',
        runId: 'run_1',
        boundAt: '2026-11-13T01:00:00.000Z',
        boundAuthority: minter
      })
    }
    const rows = new Map<string, unknown>([
      ['SELECT grant_id, run_id, receipt FROM start_grant_runs WHERE run_id = ?', binding],
      ['SELECT grant_id, receipt FROM start_grants WHERE grant_id = ?', undefined]
    ])
    const fake = {
      db: {
        prepare: (sql: string) => ({ get: () => rows.get(sql) })
      }
    }
    expect(() => readGrantForRun(fake as never, 'run_1')).toThrowError()
    try {
      readGrantForRun(fake as never, 'run_1')
    } catch (error) {
      expect(error).toMatchObject({ code: 'start_grant_invalid_record' })
    }
  })

  it('pins the grant type to the parsed shape so callers cannot drift', () => {
    const parsed: StartGrant = startGrantSchema.parse(valid())
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'authorizationRefs',
        'deadline',
        'executionAuthorized',
        'grantId',
        'kind',
        'maxWorkers',
        'mintedAt',
        'minter',
        'objectiveHash',
        'objectiveText',
        'repos',
        'schemaVersion',
        'spend',
        'taskSource',
        'writableRoots'
      ].sort()
    )
  })
})
