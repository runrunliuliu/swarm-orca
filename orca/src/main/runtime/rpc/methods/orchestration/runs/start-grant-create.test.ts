import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COORD, OPERATOR, OTHER, strictCoordinatorHarness } from '../../../strict-coordinator-test-fixture'
import { resultOf } from '../../../orchestration-session-caller-test-fixture'
import { OrchestrationDb } from '../../../../orchestration/db'
import {
  bindStartGrantToRun,
  insertStartGrant,
  insertStartGrantRevocation,
  objectiveHashOf,
  type StartGrant
} from '../../../../orchestration/start-grant-policy'

const OBJECTIVE = 'review the parser, read only'
const GRANT = '2f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d21'

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
    maxWorkers: 8,
    repos: [{ repoId: 'repo-1', worktreeIds: null }],
    writableRoots: [],
    spend: { kind: 'none' },
    deadline: overrides.deadline ?? new Date(Date.now() + 3_600_000).toISOString(),
    minter: overrides.minter ?? {
      terminalHandle: OPERATOR,
      paneKey: 'tab:9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'pty-operator:1',
      launchTokenHash: 'b'.repeat(64),
      hostScope: { kind: 'local', hostId: 'local' }
    },
    mintedAt: new Date(Date.now() - 60_000).toISOString(),
    executionAuthorized: false,
    ...overrides
  }
}

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
  terminalHandle: COORD,
  paneKey: 'tab:1aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  processIncarnation: 'pty-term_coord:1',
  launchTokenHash: 'c'.repeat(64),
  hostScope: { kind: 'local' as const, hostId: 'local' as const }
}

describe('run create under a start grant', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  let baselineRuns = 0
  beforeEach(() => {
    h = strictCoordinatorHarness(false)
    // The harness may open with a pre-existing Run row (the compatibility Run). Every count below is
    // a delta, so the assertions say "this create added nothing" rather than pinning that fixture.
    baselineRuns = h.db.listRuns({}).runs.length
  })
  afterEach(() => h.close())

  const create = (handle: string, grantId: string | undefined, objective = OBJECTIVE) =>
    h.call(
      'orchestration.runCreateGranted',
      { from: handle, objective, ...(grantId === undefined ? {} : { grant: grantId }) },
      handle
    )
  const runCount = () => h.db.listRuns({}).runs.length - baselineRuns
  const bindingRunId = (grantId: string) =>
    (
      h.db.db.prepare('SELECT run_id FROM start_grant_runs WHERE grant_id = ?').get(grantId) as
        | { run_id: string }
        | undefined
    )?.run_id

  it('creates the Run, binds the grant, and replays the same create without a second Run', async () => {
    insertStartGrant(h.db, grant())
    const first = resultOf(await create(COORD, GRANT)) as {
      run: { id: string }
      effectsApplied: boolean
    }
    expect(first.effectsApplied).toBe(true)
    expect(runCount()).toBe(1)
    expect(bindingRunId(GRANT)).toBe(first.run.id)

    const replay = resultOf(await create(COORD, GRANT)) as {
      run: { id: string }
      effectsApplied: boolean
    }
    expect(replay.effectsApplied).toBe(false)
    expect(replay.run.id).toBe(first.run.id)
    expect(runCount()).toBe(1)
  })

  it('refuses an unknown grant and writes nothing', async () => {
    expect(await create(COORD, '11111111-2222-4333-8444-555555555555')).toMatchObject({
      ok: false,
      error: { code: 'start_grant_unknown' }
    })
    expect(runCount()).toBe(0)
    expect(bindingRunId('11111111-2222-4333-8444-555555555555')).toBeUndefined()
  })

  it('refuses a revoked grant that is otherwise valid', async () => {
    const record = grant()
    insertStartGrant(h.db, record)
    insertStartGrantRevocation(h.db, {
      schemaVersion: 1,
      kind: 'start_grant_revocation',
      grantId: record.grantId,
      revokedAt: new Date().toISOString(),
      authority: record.minter,
      reason: 'owner withdrew the approval',
      executionAuthorized: false
    })
    expect(await create(COORD, record.grantId)).toMatchObject({
      ok: false,
      error: { code: 'start_grant_revoked' }
    })
    expect(runCount()).toBe(0)
  })

  it('refuses an expired grant; the deadline is the server clock, not the caller', async () => {
    const expired = grant({
      grantId: '5f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d24',
      mintedAt: new Date(Date.now() - 7_200_000).toISOString(),
      deadline: new Date(Date.now() - 3_600_000).toISOString()
    } as Partial<StartGrant>)
    insertStartGrant(h.db, expired)
    expect(await create(COORD, expired.grantId)).toMatchObject({
      ok: false,
      error: { code: 'start_grant_expired' }
    })
    expect(runCount()).toBe(0)
  })

  it('refuses an objective that differs from the approved one, even by one character', async () => {
    insertStartGrant(h.db, grant())
    expect(await create(COORD, GRANT, `${OBJECTIVE}!`)).toMatchObject({
      ok: false,
      error: { code: 'start_grant_objective_mismatch' }
    })
    expect(runCount()).toBe(0)
  })

  it('lets one grant cover only one Run, and refuses another Coordinator', async () => {
    insertStartGrant(h.db, grant())
    resultOf(await create(COORD, GRANT))
    expect(await create(OTHER, GRANT)).toMatchObject({
      ok: false,
      error: { code: 'start_grant_already_bound' }
    })
    expect(runCount()).toBe(1)
  })

  it('refuses a corrupt record instead of treating it as "no grant"', async () => {
    h.db.db
      .prepare('INSERT INTO start_grants (grant_id, receipt) VALUES (?, ?)')
      .run('6f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d25', '{"maxWorkers":8}')
    expect(await create(COORD, '6f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d25')).toMatchObject({
      ok: false,
      error: { code: 'start_grant_invalid_record' }
    })
    expect(runCount()).toBe(0)
  })

  it('requires the grant parameter: this verb is not a flag on the existing one', async () => {
    expect(await create(COORD, undefined)).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(runCount()).toBe(0)
  })

  it('leaves the plain and strict create paths untouched', async () => {
    resultOf(
      await h.call('orchestration.runCreateStrict', { from: COORD, objective: OBJECTIVE }, COORD)
    )
    expect(runCount()).toBe(1)
    expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM start_grant_runs').get()).toEqual({ n: 0 })
    expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM start_grants').get()).toEqual({ n: 0 })
  })
})

describe('start grant binding, two connections', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const filePath = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-start-grant-race-'))
    directories.push(directory)
    return join(directory, 'orchestration.db')
  }
  const open = (): OrchestrationDb => new OrchestrationDb(filePath())

  it('binds a grant to one Run and treats the same live Coordinator as a replay', () => {
    const file = filePath()
    const first = new OrchestrationDb(file)
    const second = new OrchestrationDb(file)
    const countRuns = () =>
      (first.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
    // Opening the database materialises the compatibility Run, so the assertion is a delta.
    const runsBefore = countRuns()
    try {
      const record = grant({ grantId: '7f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d26' })
      insertStartGrant(first, record)
      const created = first.createGrantedRun({
        objective: OBJECTIVE,
        coordinatorHandle: authority.terminalHandle,
        coordinatorPaneKey: authority.paneKey,
        startGrant: { grantId: record.grantId, authority }
      })
      const replay = second.createGrantedRun({
        objective: OBJECTIVE,
        coordinatorHandle: authority.terminalHandle,
        coordinatorPaneKey: authority.paneKey,
        startGrant: { grantId: record.grantId, authority }
      })
      expect(created.replayed).toBe(false)
      expect(replay.replayed).toBe(true)
      expect(replay.run.id).toBe(created.run.id)
      expectRefusal(
        () =>
          second.createGrantedRun({
            objective: OBJECTIVE,
            coordinatorHandle: 'term_other',
            coordinatorPaneKey: 'tab:3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            startGrant: {
              grantId: record.grantId,
              authority: {
                ...authority,
                terminalHandle: 'term_other',
                paneKey: 'tab:3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
              }
            }
          }),
        'start_grant_already_bound'
      )
      expect(countRuns() - runsBefore).toBe(1)
    } finally {
      second.close()
      first.close()
    }
  })

  it('cannot write while another connection holds the write lock, and replays after it commits', () => {
    // The real contention property: `BEGIN IMMEDIATE` is what makes the count/insert one step, so a
    // second writer must be refused by the database rather than proceeding on a stale read. No
    // process is needed to show that — a held write transaction is the same lock a second process
    // would block on.
    const file = filePath()
    const holder = new OrchestrationDb(file)
    const second = new OrchestrationDb(file)
    try {
      const record = grant({ grantId: 'af6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d29' })
      insertStartGrant(holder, record)
      const create = (db: OrchestrationDb) =>
        db.createGrantedRun({
          objective: OBJECTIVE,
          coordinatorHandle: authority.terminalHandle,
          coordinatorPaneKey: authority.paneKey,
          startGrant: { grantId: record.grantId, authority }
        })
      // Fail fast instead of waiting out the 5 s driver timeout: the assertion is about the lock,
      // not about how long the driver waits for it.
      second.db.pragma('busy_timeout = 100')
      holder.db.exec('BEGIN IMMEDIATE')
      expect(() => create(second)).toThrowError(/locked|busy/i)
      holder.db.exec('COMMIT')

      const created = create(holder)
      const replay = create(second)
      expect(created.replayed).toBe(false)
      expect(replay.replayed).toBe(true)
      expect(replay.run.id).toBe(created.run.id)
    } finally {
      second.close()
      holder.close()
    }
  })

  it('cannot bind one Run to two grants', () => {
    const db = open()
    try {
      const run = db.createRun({
        objective: 'plain',
        coordinatorHandle: 'term_x',
        coordinatorPaneKey: null
      })
      const one = grant({ grantId: '8f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d27' })
      const two = grant({ grantId: '9f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d28' })
      insertStartGrant(db, one)
      insertStartGrant(db, two)
      bindStartGrantToRun(db, { grantId: one.grantId, runId: run.id, boundAuthority: one.minter })
      expect(() =>
        bindStartGrantToRun(db, { grantId: two.grantId, runId: run.id, boundAuthority: two.minter })
      ).toThrowError(/UNIQUE/)
    } finally {
      db.close()
    }
  })
})
