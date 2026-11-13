import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { assertSpawnAdmissible } from './start-grant-spawn'
import {
  bindStartGrantToRun,
  insertStartGrant,
  insertStartGrantRevocation,
  objectiveHashOf,
  type StartGrant
} from './start-grant-policy'

const OBJECTIVE = 'review the parser, read only'
const GRANT = '2f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d21'
const REPO = 'repo-1'

function expectRefusal(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected a ${code} refusal`)
}

const authority = {
  terminalHandle: 'term_coord',
  paneKey: 'tab:1aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  processIncarnation: 'pty-term_coord:1',
  launchTokenHash: 'c'.repeat(64),
  hostScope: { kind: 'local' as const, hostId: 'local' as const }
}

function grant(overrides: Partial<StartGrant> = {}): StartGrant {
  const objectiveText = overrides.objectiveText ?? OBJECTIVE
  return {
    schemaVersion: 1,
    kind: 'start_grant',
    grantId: overrides.grantId ?? GRANT,
    objectiveText,
    objectiveHash: objectiveHashOf(objectiveText),
    taskSource: { path: '/tmp/approval.md', sha256: 'a'.repeat(64) },
    authorizationRefs: [],
    maxWorkers: overrides.maxWorkers ?? 2,
    repos: overrides.repos ?? [{ repoId: REPO, worktreeIds: null }],
    writableRoots: [],
    spend: { kind: 'none' },
    deadline: overrides.deadline ?? new Date(Date.now() + 3_600_000).toISOString(),
    minter: overrides.minter ?? authority,
    mintedAt: new Date(Date.now() - 60_000).toISOString(),
    executionAuthorized: false,
    ...overrides
  }
}

describe('spawn admission under a start grant', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const file = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-start-grant-spawn-'))
    directories.push(directory)
    return join(directory, 'orchestration.db')
  }
  const open = (path = file()) => new OrchestrationDb(path)

  const grantedRun = (db: OrchestrationDb, record = grant(), coordinator = 1) => {
    // One Coordinator owns one Run: a second granted Run in the same database needs its own pane.
    const paneKey = `tab:${coordinator}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    const coordinatorAuthority = {
      ...authority,
      terminalHandle: `term_coord_${coordinator}`,
      paneKey,
      launchTokenHash: createHash('sha256').update(`launch-${coordinator}`).digest('hex')
    }
    const run = db.createRun({
      objective: OBJECTIVE,
      coordinatorHandle: coordinatorAuthority.terminalHandle,
      coordinatorPaneKey: paneKey,
      strictCoordinator: coordinatorAuthority
    })
    insertStartGrant(db, record)
    bindStartGrantToRun(db, {
      grantId: record.grantId,
      runId: run.id,
      boundAuthority: coordinatorAuthority
    })
    return run
  }

  const spawn = (
    db: OrchestrationDb,
    runId: string,
    scope: {
      repoId?: string | null
      worktreeId?: string | null
      federated?: boolean
    } = {},
    spec = 'worker'
  ) =>
    db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: spec,
      taskRunId: runId,
      repoId: scope.repoId === undefined ? REPO : scope.repoId,
      worktreeId: scope.worktreeId === undefined ? 'wt-1' : scope.worktreeId,
      federated: scope.federated,
      startOptions: { topology: 'current' }
    })

  const counts = (db: OrchestrationDb) => ({
    dispatches: (db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get() as { n: number }).n,
    workers: (db.db.prepare('SELECT COUNT(*) AS n FROM worker_dispatches').get() as { n: number }).n,
    tasks: (db.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
  })

  it('refuses the spawn past maxWorkers and writes nothing at all', () => {
    const db = open()
    try {
      const run = grantedRun(db)
      spawn(db, run.id, {}, 'w1')
      spawn(db, run.id, {}, 'w2')
      const before = counts(db)
      const receipts = (db.db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get() as { n: number })
        .n
      expectRefusal(() => spawn(db, run.id, {}, 'w3'), 'start_grant_worker_limit')
      // The first persistent write of this transaction is the mutation receipt; a refusal after it
      // would leave a "this was accepted" row for a Worker that never started.
      expect(counts(db)).toEqual(before)
      expect(
        (db.db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get() as { n: number }).n
      ).toBe(receipts)
    } finally {
      db.close()
    }
  })

  it('names the active Dispatches in the refusal so the operator can converge', () => {
    const db = open()
    try {
      const run = grantedRun(db, grant({ maxWorkers: 1 }))
      const first = spawn(db, run.id, {}, 'w1')
      try {
        spawn(db, run.id, {}, 'w2')
        throw new Error('expected a refusal')
      } catch (error) {
        expect(error).toMatchObject({
          code: 'start_grant_worker_limit',
          data: {
            maxWorkers: 1,
            active: [{ dispatchId: first.dispatch.id, status: 'pending', observedAt: expect.any(String) }]
          }
        })
      }
    } finally {
      db.close()
    }
  })

  it('counts only active Dispatches: a settled one frees the slot', () => {
    const db = open()
    try {
      const run = grantedRun(db, grant({ maxWorkers: 1 }))
      const first = spawn(db, run.id, {}, 'w1')
      expectRefusal(() => spawn(db, run.id, {}, 'w2'), 'start_grant_worker_limit')
      db.completeDispatch(first.dispatch.id)
      expect(() => spawn(db, run.id, {}, 'w3')).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('refuses a repo outside the grant', () => {
    const db = open()
    try {
      const run = grantedRun(db)
      expectRefusal(() => spawn(db, run.id, { repoId: 'repo-other' }), 'start_grant_repo_not_granted')
      expect(counts(db)).toEqual({ dispatches: 0, workers: 0, tasks: 0 })
    } finally {
      db.close()
    }
  })

  it('refuses an unresolvable repo instead of treating it as allowed', () => {
    const db = open()
    try {
      const run = grantedRun(db)
      expectRefusal(() => spawn(db, run.id, { repoId: null }), 'start_grant_repo_not_granted')
    } finally {
      db.close()
    }
  })

  it('allows creating a worktree only under a repo-wide scope', () => {
    const db = open()
    try {
      const run = grantedRun(
        db,
        grant({ repos: [{ repoId: REPO, worktreeIds: ['wt-1'] }] })
      )
      // new-child/new-top-level: no worktree id exists yet, and an enumerated list cannot authorise it.
      expectRefusal(() => spawn(db, run.id, { worktreeId: null }), 'start_grant_repo_not_granted')
      expect(() => spawn(db, run.id, { worktreeId: 'wt-1' })).not.toThrow()
      expect(() => spawn(db, run.id, { worktreeId: 'wt-2' }), 'start_grant_repo_not_granted')
    } finally {
      db.close()
    }
  })

  it('keeps a worktree this Run already created inside the grant scope', () => {
    const db = open()
    try {
      const run = grantedRun(db, grant({ repos: [{ repoId: REPO, worktreeIds: ['wt-1'] }] }))
      const created = spawn(db, run.id, { worktreeId: 'wt-1' }, 'creator')
      db.db
        .prepare('UPDATE worker_dispatches SET worktree_id = ? WHERE dispatch_id = ?')
        .run('wt-created', created.dispatch.id)
      expect(() => spawn(db, run.id, { worktreeId: 'wt-created' })).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('refuses a federated spawn: the count cannot see another host', () => {
    const db = open()
    try {
      const run = grantedRun(db)
      expect(() => spawn(db, run.id, { federated: true }), 'start_grant_remote_unsupported')
      expect(counts(db)).toEqual({ dispatches: 0, workers: 0, tasks: 0 })
    } finally {
      db.close()
    }
  })

  it('refuses an expired or revoked grant at spawn, not only at create', () => {
    const db = open()
    try {
      const expired = grant({
        grantId: '5f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d24',
        mintedAt: new Date(Date.now() - 7_200_000).toISOString(),
        deadline: new Date(Date.now() - 3_600_000).toISOString()
      })
      const expiredRun = grantedRun(db, expired)
      expect(() => spawn(db, expiredRun.id), 'start_grant_expired')

      const revoked = grant({ grantId: '6f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d25' })
      const revokedRun = grantedRun(db, revoked, 2)
      insertStartGrantRevocation(db, {
        schemaVersion: 1,
        kind: 'start_grant_revocation',
        grantId: revoked.grantId,
        revokedAt: new Date().toISOString(),
        authority,
        reason: 'owner withdrew the approval',
        executionAuthorized: false
      })
      expectRefusal(() => spawn(db, revokedRun.id), 'start_grant_revoked')
    } finally {
      db.close()
    }
  })

  it('fails closed for a strict Run with no grant once the switch is on, and never for a plain Run', () => {
    const db = open()
    try {
      const strictRun = db.createRun({
        objective: 'strict without a grant',
        coordinatorHandle: authority.terminalHandle,
        coordinatorPaneKey: authority.paneKey,
        strictCoordinator: authority
      })
      // Both switch states, because the constant is the only thing between "this commit lands" and
      // "every strict Run created before grants existed stops being able to dispatch". The refusal is
      // asserted on the predicate itself: the insert site passes the shipped constant, and a per-call
      // override there would be a bypass nobody should be able to reach.
      expectRefusal(
        () =>
          assertSpawnAdmissible(db, {
            runId: strictRun.id,
            repoId: REPO,
            worktreeId: 'wt-1',
            startGrantRequired: true
          }),
        'start_grant_required'
      )
      expect(counts(db)).toEqual({ dispatches: 0, workers: 0, tasks: 0 })
      expect(() => spawn(db, strictRun.id, {}, 'legacy')).not.toThrow()

      const plainRun = db.createRun({
        objective: 'plain',
        coordinatorHandle: 'term_plain',
        coordinatorPaneKey: 'tab:4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      expect(() => spawn(db, plainRun.id)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('applies the same cap to the adopted-terminal path, before writing its row', () => {
    const db = open()
    try {
      const run = grantedRun(db, grant({ maxWorkers: 1 }))
      const task = db.createTask({ runId: run.id, spec: 'adopt' })
      const adopt = () =>
        db.createDispatchContext({
          taskId: task.id,
          assigneeHandle: 'term_worker',
          assigneePaneKey: 'tab:5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          repoId: REPO,
          worktreeId: 'wt-1'
        })
      adopt()
      expect(() => adopt(), 'start_grant_worker_limit')
      expect(
        (db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get() as { n: number }).n
      ).toBe(1)
    } finally {
      db.close()
    }
  })

  it('holds the cap across two connections', () => {
    const path = file()
    const first = open(path)
    const second = new OrchestrationDb(path)
    try {
      const run = grantedRun(first, grant({ maxWorkers: 1 }))
      spawn(first, run.id, {}, 'w1')
      // Two connections, one shared database: the second sees the committed row, so the cap holds
      // without relying on a single process's memory.
      expectRefusal(() => spawn(second, run.id, {}, 'w2'), 'start_grant_worker_limit')
    } finally {
      second.close()
      first.close()
    }
  })
})
