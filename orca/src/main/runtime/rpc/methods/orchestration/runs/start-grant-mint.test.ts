import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COORD, OPERATOR, strictCoordinatorHarness } from '../../../strict-coordinator-test-fixture'
import { resultOf } from '../../../orchestration-session-caller-test-fixture'
import { objectiveHashOf, type StartGrant } from '../../../../orchestration/start-grant-policy'

const OBJECTIVE = 'review the parser, read only'
const GRANT = '2f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d21'

type Harness = ReturnType<typeof strictCoordinatorHarness>

/** The five identity fields the contract stores, taken from the harness's live authority. */
function liveAuthority(h: Harness, handle: string) {
  const authority = h.authorities.get(handle)
  if (!authority) {
    throw new Error(`no authority for ${handle}`)
  }
  return {
    terminalHandle: authority.terminalHandle,
    paneKey: authority.paneKey as string,
    processIncarnation: authority.processIncarnation as string,
    launchTokenHash: authority.launchTokenHash as string,
    hostScope: authority.hostScope
  }
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'start_grant',
    grantId: GRANT,
    objectiveText: OBJECTIVE,
    objectiveHash: objectiveHashOf(OBJECTIVE),
    taskSource: { path: '/tmp/approval.md', sha256: 'a'.repeat(64) },
    authorizationRefs: [],
    maxWorkers: 8,
    repos: [{ repoId: 'repo-1', worktreeIds: null }],
    writableRoots: [],
    spend: { kind: 'none' },
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    mintedAt: new Date(Date.now() - 60_000).toISOString(),
    executionAuthorized: false,
    ...overrides
  }
}

describe('start grant mint, show and revoke', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(false)
  })
  afterEach(() => h.close())

  const mint = (overrides: Record<string, unknown> = {}, from = OPERATOR) =>
    h.call('orchestration.startGrantMint', { from, record: record(overrides) }, from)
  const show = (grant = GRANT, from?: string) =>
    h.call('orchestration.startGrantShow', { grant, ...(from ? { from } : {}) }, from)
  const revoke = (grant: string, reason: string, from = OPERATOR) =>
    h.call('orchestration.startGrantRevoke', { from, grant, reason }, from)

  it('stores the record as the minting terminal, and replays an identical mint without a second row', async () => {
    // The same bytes, not a regenerated record: a retry has to resubmit what it first sent (the
    // minter therefore persists its record instead of re-deriving timestamps).
    const submitted = record()
    const send = (body: Record<string, unknown>) =>
      h.call('orchestration.startGrantMint', { from: OPERATOR, record: body }, OPERATOR)
    const first = resultOf(await send(submitted)) as { grant: StartGrant; effectsApplied: boolean }
    expect(first.effectsApplied).toBe(true)
    expect(first.grant.minter.terminalHandle).toBe(OPERATOR)

    const replay = resultOf(await send(submitted)) as { grant: StartGrant; effectsApplied: boolean }
    expect(replay.effectsApplied).toBe(false)
    expect(replay.grant).toEqual(first.grant)
    expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM start_grants').get()).toEqual({ n: 1 })
  })

  it('refuses a second, different record under the same grant id', async () => {
    resultOf(await mint())
    expect(await mint({ maxWorkers: 9 })).toMatchObject({
      ok: false,
      error: { code: 'start_grant_record_conflict' }
    })
    const stored = resultOf(await show()) as { grant: StartGrant }
    expect(stored.grant.maxWorkers).toBe(8)
  })

  it('refuses a record that names its own minter, and writes the verified caller instead', async () => {
    // A caller cannot read its own launch token, so a client-built `minter` could never match the
    // authority the server verifies; accepting one would let a record claim another terminal.
    expect(
      await h.call(
        'orchestration.startGrantMint',
        { from: OPERATOR, record: record({ minter: liveAuthority(h, OPERATOR) }) },
        OPERATOR
      )
    ).toMatchObject({ ok: false, error: { code: 'start_grant_invalid_record' } })
    expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM start_grants').get()).toEqual({ n: 0 })

    const stored = resultOf(await mint()) as { grant: StartGrant }
    expect(stored.grant.minter).toEqual(liveAuthority(h, OPERATOR))
  })

  it('refuses a record whose hash does not match its own objective', async () => {
    expect(await mint({ objectiveHash: 'f'.repeat(64) })).toMatchObject({
      ok: false,
      error: { code: 'start_grant_invalid_record' }
    })
    expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM start_grants').get()).toEqual({ n: 0 })
  })

  it('requires a live terminal caller to mint, and writes nothing without one', async () => {
    expect(
      await h.call('orchestration.startGrantMint', { from: OPERATOR, record: record() })
    ).toMatchObject(
      { ok: false, error: { code: 'strict_coordinator_required' } }
    )
    expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM start_grants').get()).toEqual({ n: 0 })
  })

  it('shows the derived state, the covering Run and the withdrawal, and refuses an unknown grant', async () => {
    resultOf(await mint())
    const shown = resultOf(await show()) as {
      state: { valid: boolean; expired: boolean; revoked: boolean }
      run: { id: string } | null
    }
    expect(shown.state).toMatchObject({ valid: true, expired: false, revoked: false })
    expect(shown.run).toBeNull()

    expect(await show('11111111-2222-4333-8444-555555555555')).toMatchObject({
      ok: false,
      error: { code: 'start_grant_unknown' }
    })
  })

  it('derives expiry from the server clock instead of storing a verdict', async () => {
    resultOf(
      await mint({
        mintedAt: new Date(Date.now() - 7_200_000).toISOString(),
        deadline: new Date(Date.now() - 3_600_000).toISOString()
      })
    )
    const shown = resultOf(await show()) as {
      state: { valid: boolean; expired: boolean }
    }
    expect(shown.state).toMatchObject({ valid: false, expired: true })
  })

  it('records one withdrawal, replays the same intent, and refuses a different one', async () => {
    resultOf(await mint())
    const first = resultOf(await revoke(GRANT, 'owner withdrew the approval')) as {
      revocation: { revokedAt: string }
      effectsApplied: boolean
    }
    expect(first.effectsApplied).toBe(true)

    const replay = resultOf(await revoke(GRANT, 'owner withdrew the approval')) as {
      revocation: { revokedAt: string }
      effectsApplied: boolean
    }
    expect(replay.effectsApplied).toBe(false)
    expect(replay.revocation.revokedAt).toBe(first.revocation.revokedAt)

    expect(await revoke(GRANT, 'a different reason')).toMatchObject({
      ok: false,
      error: { code: 'start_grant_record_conflict' }
    })
    const shown = resultOf(await show()) as {
      state: { valid: boolean; revoked: boolean; revokedReason: string }
    }
    expect(shown.state).toMatchObject({
      valid: false,
      revoked: true,
      revokedReason: 'owner withdrew the approval'
    })
  })

  it('refuses to withdraw a grant that was never minted', async () => {
    expect(await revoke('11111111-2222-4333-8444-555555555555', 'r')).toMatchObject({
      ok: false,
      error: { code: 'start_grant_unknown' }
    })
  })

  it('reports the Run a grant covers, once one is created under it', async () => {
    resultOf(await mint())
    const created = resultOf(
      await h.call('orchestration.runCreateGranted', { from: COORD, objective: OBJECTIVE, grant: GRANT }, COORD)
    ) as { run: { id: string } }
    const shown = resultOf(await show()) as {
      run: { id: string } | null
      workers: { active: number; max: number }
    }
    expect(shown.run?.id).toBe(created.run.id)
    expect(shown.workers).toEqual({ active: 0, max: 8 })
  })
})
