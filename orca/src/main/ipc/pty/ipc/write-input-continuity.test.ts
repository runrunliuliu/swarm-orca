import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strictCoordinatorHarness } from '../../../runtime/rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from '../../../runtime/orchestration/strict-continuity-store'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal-input'
import { createPtyWriteInput } from './write-input'
import { ptyOwnership } from '../provider/ownership-state'

const { provider } = vi.hoisted(() => ({ provider: { write: vi.fn(), hasPty: () => true } }))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => provider }))

describe('renderer input continuity admission', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  let runId: string
  beforeEach(async () => {
    h = strictCoordinatorHarness()
    runId = await h.create()
    ptyOwnership.set('input-pty', null)
    provider.write.mockReset()
  })
  afterEach(() => {
    ptyOwnership.delete('input-pty')
    h.close()
  })
  const seal = () =>
    sealStrictContinuityDatabase(h.db, {
      runId,
      sourceRuntimeId: h.runtime.getRuntimeId(),
      expiresAtMs: Date.now() + 60_000
    })

  it.each(['writePtyInput', 'writePtyInputAccepted'] as const)(
    'refuses %s before recording input',
    (writer) => {
      const record = vi.spyOn(h.runtime.terminalRunFacts, 'recordInput')
      seal()
      const input = createPtyWriteInput({ runtime: h.runtime })
      expect(input[writer]({ id: 'input-pty', data: 'no', inputKind: 'driving' })).toBe(false)
      expect(record).not.toHaveBeenCalled()
      expect(provider.write).not.toHaveBeenCalled()
    }
  )

  it('rechecks between chunks and refuses completion after a seal; never replays the first chunk', async () => {
    provider.write.mockImplementationOnce(() => {
      queueMicrotask(seal)
    })
    const input = createPtyWriteInput({ runtime: h.runtime })
    const payload = {
      id: 'input-pty',
      data: 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 1),
      inputKind: 'driving' as const
    }
    expect(await input.writePtyInput(payload)).toBe(false)
    expect(provider.write).toHaveBeenCalledOnce()
    expect(await input.writePtyInput(payload)).toBe(false)
    expect(provider.write).toHaveBeenCalledOnce()
  })
})
