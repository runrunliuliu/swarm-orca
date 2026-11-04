import { afterEach, describe, expect, it, vi } from 'vitest'
import { TraeMailboxDelivery, type TraeMailboxTarget } from './trae-mailbox-delivery'
import { readTraeIdleLogEvidence } from './trae-idle-log-evidence'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import type { TraeIdleRevalidationRequest } from '../agent-hooks/trae-idle-revalidation'

vi.mock('./trae-idle-log-evidence', () => ({
  readTraeIdleLogEvidence: vi.fn(async () => 'same-log')
}))
afterEach(() => vi.clearAllMocks())

function harness(options: { publishObservation?: boolean } = {}) {
  const at = Date.now() - 3_600_000
  const input = { sequence: 1, lastInputAt: at - 10, observedSince: at - 100, complete: true }
  const confirm = vi.fn(async () => 'traex')
  const write = vi.fn(() => {
    input.sequence++
    input.lastInputAt = Date.now()
    return true
  })
  const target: TraeMailboxTarget = {
    row: {
      paneKey: 'pane',
      connectionId: null,
      launchToken: 'launch',
      state: 'done',
      agentType: 'trae',
      prompt: '',
      receivedAt: at,
      evidenceObservedAt: at,
      stateStartedAt: at,
      providerSession: { key: 'session_id', id: 'session', transcriptPath: '/rollout.jsonl' }
    },
    restoredLaunchAttested: false,
    input,
    incarnation: 'inc',
    outputSequence: 1,
    handle: 'term',
    localProbeAllowed: true,
    controller: {
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => false,
      getForegroundProcess: confirm,
      confirmForegroundProcess: confirm
    }
  }
  const publish = vi.fn((_pty: string, request: TraeIdleRevalidationRequest) => {
    target.row = {
      ...target.row,
      receivedAt: Date.now(),
      evidenceObservedAt: Date.now(),
      traeIdleRevalidation: request.proof,
      ...(options.publishObservation === false
        ? {}
        : {
            observation: {
              authorityId: 'main-agent-hooks',
              incarnation: 1,
              revision: 1,
              origin: 'process',
              kind: 'snapshot',
              observedAt: Date.now()
            }
          })
    }
  })
  const redrive = vi.fn()
  const delivery = new TraeMailboxDelivery({
    target: () => ({ ...target, input: { ...input } }),
    publish,
    redrive
  })
  return { target, input, confirm, write, publish, redrive, delivery }
}

describe('Trae mailbox delivery revalidation', () => {
  it('renews stale evidence, fences the draft and submits without republishing it as idle', async () => {
    const { delivery, publish, redrive, write } = harness()
    expect(delivery.status('pty')).toBeNull()
    expect(await delivery.revalidator.probe('pty')).toBe(true)
    expect(delivery.status('pty')?.state).toBe('done')
    expect((await delivery.write('pty', 'pointer', () => true)).outcome).toBe('accepted')
    expect(delivery.status('pty')).toBeNull()
    expect(delivery.status('pty', true)?.state).toBe('done')
    expect((await delivery.write('pty', '\r', () => true)).outcome).toBe('accepted')
    expect(delivery.status('pty', true)).toBeNull()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(redrive).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('redrives a revalidated stale Stop row even when no observation revision is present', async () => {
    const { delivery, redrive } = harness({ publishObservation: false })
    expect(delivery.status('pty')).toBeNull()
    expect(await delivery.revalidator.probe('pty')).toBe(true)
    expect(delivery.status('pty')?.state).toBe('done')
    expect(redrive).toHaveBeenCalledTimes(1)
  })

  it('does not use local IO when the execution-host gate refuses the target', async () => {
    const { delivery, target, confirm } = harness()
    target.localProbeAllowed = false
    expect(await delivery.revalidator.probe('pty')).toBe(false)
    expect(readTraeIdleLogEvidence).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects a publication not accepted by the canonical store', async () => {
    const { delivery, publish, redrive } = harness()
    publish.mockImplementation(() => {})
    expect(await delivery.revalidator.probe('pty')).toBe(false)
    expect(delivery.status('pty')).toBeNull()
    expect(redrive).not.toHaveBeenCalled()
  })

  it('invalidates revalidated idle on any external input', async () => {
    const { delivery, input, write } = harness()
    await delivery.revalidator.probe('pty')
    input.sequence++
    input.lastInputAt = Date.now()
    expect(delivery.status('pty')).toBeNull()
    expect((await delivery.write('pty', 'pointer', () => true)).outcome).toBe('refused')
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['input', 'output', 'session', 'incarnation', 'log', 'gate'])(
    'refuses Enter after %s races and clears the draft fence',
    async (kind) => {
      const { delivery, input, target, confirm, write, publish } = harness()
      await delivery.revalidator.probe('pty')
      await delivery.write('pty', 'pointer', () => true)
      const originalProof = target.row.traeIdleRevalidation
      confirm.mockImplementationOnce(async () => {
        if (kind === 'input') {
          input.sequence++
        }
        if (kind === 'output') {
          target.outputSequence++
        }
        if (kind === 'session') {
          target.row.providerSession!.id = 'other'
        }
        if (kind === 'incarnation') {
          target.incarnation = 'other'
        }
        return 'traex'
      })
      if (kind === 'log') {
        vi.mocked(readTraeIdleLogEvidence)
          .mockResolvedValueOnce('before')
          .mockResolvedValueOnce('after')
      }
      expect((await delivery.write('pty', '\r', () => kind !== 'gate')).outcome).toBe('refused')
      expect(write).toHaveBeenCalledTimes(1)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(target.row.traeIdleRevalidation).toBe(originalProof)
      expect(delivery.status('pty', true)).toBeNull()
    }
  )

  it('clears a staged input on lifecycle invalidation', async () => {
    const { delivery, write } = harness()
    await delivery.revalidator.probe('pty')
    await delivery.write('pty', 'pointer', () => true)
    delivery.clear('pty')
    expect(delivery.status('pty', true)).toBeNull()
    expect((await delivery.write('pty', '\r', () => true)).outcome).toBe('refused')
    expect(write).toHaveBeenCalledTimes(1)
  })
})
