import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COORD, OTHER, strictCoordinatorHarness } from './strict-coordinator-test-fixture'
import { resultOf } from './orchestration-session-caller-test-fixture'
import { isOrchestrationMutation } from '../../../shared/orchestration-rpc-contract'

describe.each([false, true])('strict caller check (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
  })
  afterEach(() => h.close())

  it('uses real proof verification, returns only public identity, and does not create a Run', async () => {
    const before = h.db.listRuns({}).runs
    const result = resultOf(await h.call('orchestration.strictCallerCheck', { from: COORD }, COORD))
    expect(result).toEqual({
      coordinatorPolicy: 'strict-v1',
      caller: {
        terminalHandle: COORD,
        paneKey: h.authorities.get(COORD)?.paneKey,
        processIncarnation: h.authorities.get(COORD)?.processIncarnation,
        hostScope: { kind: 'local', hostId: 'local' },
        authorityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      checkedAt: expect.any(String),
      effectsApplied: false
    })
    expect(JSON.stringify(result)).not.toContain('launchToken')
    expect(h.db.listRuns({}).runs).toEqual(before)
    expect(isOrchestrationMutation('orchestration.strictCallerCheck', { from: COORD })).toBe(false)
  })

  it('rejects a shell handle or a different native caller with no effects', async () => {
    const before = h.db.listRuns({}).runs
    for (const caller of [undefined, OTHER]) {
      expect(
        await h.call('orchestration.strictCallerCheck', { from: COORD }, caller)
      ).toMatchObject({ ok: false, error: { code: 'strict_coordinator_required' } })
    }
    expect(h.db.listRuns({}).runs).toEqual(before)
  })

  it('does not let a previous success authorize creation after process authority is retired', async () => {
    const before = h.db.listRuns({}).runs
    resultOf(await h.call('orchestration.strictCallerCheck', { from: COORD }, COORD))
    h.authorities.delete(COORD)
    for (const method of ['orchestration.strictCallerCheck', 'orchestration.runCreateStrict']) {
      expect(
        await h.call(method, { from: COORD, objective: 'must not create' }, COORD)
      ).toMatchObject({ ok: false, error: { code: 'strict_coordinator_required' } })
    }
    expect(h.db.listRuns({}).runs).toEqual(before)
  })
})
