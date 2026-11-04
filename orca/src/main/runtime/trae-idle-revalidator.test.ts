import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TraeIdleRevalidationRequest } from '../agent-hooks/trae-idle-revalidation'
import { TraeIdleRevalidator, type TraeIdleProbeTarget } from './trae-idle-revalidator'
import { readTraeIdleLogEvidence } from './trae-idle-log-evidence'

vi.mock('./trae-idle-log-evidence', () => ({
  readTraeIdleLogEvidence: vi.fn(async () => 'same-log')
}))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
function harness() {
  const at = Date.now() - 3_600_000
  const target: TraeIdleProbeTarget = {
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
    input: { sequence: 1, lastInputAt: at - 10, observedSince: at - 100, complete: true },
    incarnation: 'inc',
    outputSequence: 1,
    controller: {},
    confirmForeground: vi.fn(async () => 'traex')
  }
  const publish = vi.fn((_ptyId: string, _request: TraeIdleRevalidationRequest) => true)
  const probe = new TraeIdleRevalidator({ target: () => target, publish })
  return { target, publish, probe }
}

function launchHash(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}

describe('Trae idle revalidation fences', () => {
  it('rechecks the log around a live foreground observation and publishes once', async () => {
    const { probe, publish } = harness()
    const first = probe.probe('pty')
    expect(probe.probe('pty')).toBe(first)
    expect(await first).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(readTraeIdleLogEvidence).toHaveBeenCalledTimes(2)
  })
  it('rejects a snapshot launch hash without authenticated reattach evidence', async () => {
    const { target, probe, publish } = harness()
    target.row.launchTokenHash = launchHash(target.row.launchToken!)
    delete target.row.launchToken
    expect(await probe.probe('pty')).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(readTraeIdleLogEvidence).not.toHaveBeenCalled()
  })
  it('accepts restart-hydrated reattach facts only before new local input', async () => {
    const { target, probe, publish } = harness()
    target.row.launchTokenHash = launchHash(target.row.launchToken!)
    delete target.row.launchToken
    target.restoredLaunchAttested = true
    target.input.complete = false
    target.input.observedSince = Date.now()
    target.input.lastInputAt = null
    expect(await probe.probe('pty')).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)

    publish.mockClear()
    target.row.traeIdleRevalidation = undefined
    target.input.lastInputAt = Date.now()
    expect(await probe.probe('pty')).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })
  it.each([
    'working',
    'restored',
    'identity-only',
    'input after stop',
    'unobserved history',
    'adopted',
    'future'
  ])('refuses %s without probing', async (kind) => {
    const { target, probe, publish } = harness()
    if (kind === 'working') {
      target.row.state = 'working'
    }
    if (kind === 'restored') {
      target.row.restoredUnconfirmed = true
    }
    if (kind === 'identity-only') {
      target.row.providerSessionOnly = true
    }
    if (kind === 'input after stop') {
      target.input.lastInputAt = Date.now()
    }
    if (kind === 'unobserved history') {
      target.input.observedSince = Date.now()
    }
    if (kind === 'adopted') {
      target.input.complete = false
    }
    if (kind === 'future') {
      target.row.evidenceObservedAt = Date.now() + 1_000
    }
    expect(await probe.probe('pty')).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(readTraeIdleLogEvidence).not.toHaveBeenCalled()
  })
  it.each([
    'input',
    'output',
    'session',
    'incarnation',
    'controller',
    'working',
    'hook',
    'reattach'
  ])(
    'rejects %s racing the foreground check',
    async (kind) => {
      const { target, probe, publish } = harness()
      target.confirmForeground = async () => {
        if (kind === 'input') {
          target.input.sequence++
        }
        if (kind === 'output') {
          target.outputSequence++
        }
        if (kind === 'session') {
          target.row.providerSession!.id = 'new-session'
        }
        if (kind === 'incarnation') {
          target.incarnation = 'new-inc'
        }
        if (kind === 'controller') {
          target.controller = {}
        }
        if (kind === 'working') {
          target.row.state = 'working'
        }
        if (kind === 'hook') {
          target.row.receivedAt++
        }
        if (kind === 'reattach') {
          target.restoredLaunchAttested = !target.restoredLaunchAttested
        }
        return 'traex'
      }
      expect(await probe.probe('pty')).toBe(false)
      expect(publish).not.toHaveBeenCalled()
    }
  )
  it.each([null, 'zsh'])('refuses unproven foreground %s', async (foreground) => {
    const { target, probe, publish } = harness()
    target.confirmForeground = async () => foreground
    expect(await probe.probe('pty')).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })
  it('refuses a log change during foreground inspection', async () => {
    vi.mocked(readTraeIdleLogEvidence)
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after')
    const { probe, publish } = harness()
    expect(await probe.probe('pty')).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })
  it('does not report success when the canonical store refuses publication', async () => {
    const { probe, publish } = harness()
    publish.mockReturnValue(false)
    expect(await probe.probe('pty')).toBe(false)
  })
  it('does not reuse a background probe as the send-time recheck', async () => {
    const { target, probe } = harness()
    let finish: (foreground: string) => void = () => {}
    target.confirmForeground = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const background = probe.probe('pty')
    await Promise.resolve()
    expect(await probe.probe('pty', true)).toBe(false)
    finish('traex')
    expect(await background).toBe(true)
  })
  it('permits only its own single pointer input for the Enter recheck', async () => {
    const { target, probe, publish } = harness()
    target.row.traeIdleRevalidation = {
      hookObservedAt: target.row.receivedAt,
      inputSequence: 1,
      processIncarnation: target.incarnation
    }
    target.input.sequence = 2
    target.input.lastInputAt = Date.now()
    expect(await probe.probe('pty', true)).toBe(false)
    expect(await probe.probe('pty', true, 2)).toBe(true)
    expect(publish).not.toHaveBeenCalled()
    target.input.sequence = 3
    expect(await probe.probe('pty', true, 2)).toBe(false)
  })
  it('bounds a hung probe, keeps one outstanding operation and never publishes late', async () => {
    vi.useFakeTimers()
    const { target, probe, publish } = harness()
    let finish: (value: string) => void = () => {}
    target.confirmForeground = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = probe.probe('pty')
    await vi.advanceTimersByTimeAsync(2_001)
    expect(await pending).toBe(false)
    expect(probe.probe('pty')).toBe(pending)
    finish('traex')
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).not.toHaveBeenCalled()
  })
})
