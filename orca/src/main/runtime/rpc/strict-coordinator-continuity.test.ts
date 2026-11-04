import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COORD, OPERATOR, strictCoordinatorHarness } from './strict-coordinator-test-fixture'
import { resultOf } from './orchestration-session-caller-test-fixture'
import {
  sealStrictContinuityDatabase,
  verifyStrictContinuityDatabase
} from '../orchestration/strict-continuity-store'
import {
  withStrictCoordinatorExclusive,
  withStrictCoordinatorQuiescence
} from './strict-coordinator-quiescence'

describe.each([false, true])('continuity foundation (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function seal(runId: string) {
    return withStrictCoordinatorExclusive(h.runtime, async () =>
      sealStrictContinuityDatabase(h.db, {
        runId,
        sourceRuntimeId: h.runtime.getRuntimeId(),
        expiresAtMs: Date.now() + 60_000
      })
    )
  }

  it('fences writes and durable replay without erasing mail or changing the owner', async () => {
    const runId = await h.create()
    const params = { from: OPERATOR, to: COORD, body: 'external fact' }
    resultOf(await h.call('orchestration.send', params, OPERATOR, 'fact'))
    const frozen = await seal(runId)
    h.nudge.mockClear()
    for (const response of [
      await h.call('orchestration.send', params, OPERATOR, 'fact'),
      await h.call('orchestration.check', { run: runId, from: COORD }, COORD),
      await h.call('terminal.send', { terminal: COORD, text: 'resume', enter: true }),
      await h.call(
        'orchestration.taskCreate',
        { run: runId, callerTerminalHandle: COORD, spec: 'x' },
        COORD
      )
    ]) {
      expect(response).toMatchObject({ ok: false, error: { code: 'strict_continuity_required' } })
    }
    expect(h.nudge).not.toHaveBeenCalled()
    expect(h.rawSend).not.toHaveBeenCalled()
    expect(h.db.getRun(runId)).toMatchObject({ coordinator_handle: COORD, consumer_generation: 1 })
    expect(resultOf(await h.call('orchestration.runShow', { id: runId }))).toHaveProperty('run')
    expect(
      verifyStrictContinuityDatabase(h.db, {
        runId,
        databaseId: frozen.seal.databaseId,
        sealCanonicalSha256: frozen.sealCanonicalSha256
      })
    ).toMatchObject({
      databaseConsistent: true,
      serverContinuityVerified: false,
      executionAuthorized: false
    })
  })

  it.each(['terminal.send', 'agentSession.send', 'orchestration.check'])(
    'counts the whole in-flight %s operation, including calls without request IDs',
    async (method) => {
      let release!: () => void
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const effect = withStrictCoordinatorQuiescence(h.runtime, method, {}, () => wait)
      const exclusive = vi.fn(async () => undefined)
      await expect(withStrictCoordinatorExclusive(h.runtime, exclusive)).rejects.toThrow(
        'quiescent'
      )
      expect(exclusive).not.toHaveBeenCalled()
      release()
      await effect
      await withStrictCoordinatorExclusive(h.runtime, async () => {
        await expect(
          withStrictCoordinatorQuiescence(h.runtime, method, {}, exclusive)
        ).rejects.toThrow('exclusive control')
        expect(exclusive).not.toHaveBeenCalled()
      })
      await withStrictCoordinatorExclusive(h.runtime, exclusive)
      expect(exclusive).toHaveBeenCalledOnce()
    }
  )

  it('does not expose the incomplete seal or resume protocol as RPCs', async () => {
    expect(await h.call('orchestration.runResumeStrict', {})).toMatchObject({ ok: false })
    expect(await h.call('orchestration.runSealStrict', {})).toMatchObject({ ok: false })
  })
})
