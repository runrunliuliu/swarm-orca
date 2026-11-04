import { z } from 'zod'
import type { DaemonRequest } from './types'

export type PlannedRestartRequest = {
  id: string
  type: 'plannedRestartFreeze' | 'plannedRestartInspect' | 'plannedRestartRelease'
  payload: { transitionId: string; token: string }
}

const Pin = z.object({ transitionId: z.string().uuid(), token: z.string().uuid() }).strict()
const observations = new Set<DaemonRequest['type']>([
  'ping',
  'listSessions',
  'getCwd',
  'getForegroundProcess',
  'inspectProcess',
  'confirmForegroundProcess',
  'confirmShellForeground',
  'getSnapshot',
  'getSize',
  'systemResolverHealth',
  'detach'
])

/** Lives with the surviving daemon, not the reconnecting Server's transport. */
export class DaemonPlannedRestartFence {
  private pin: z.infer<typeof Pin> | undefined
  private state: 'draining' | 'frozen' | 'released' | undefined
  private owner: string | undefined
  private readonly inFlight = new Set<Promise<void>>()
  private drain: Promise<void> | undefined
  private readonly completed = new Set<string>()
  private effectStarted = false

  constructor(private readonly freezeSessions: (frozen: boolean) => void = () => {}) {}

  async execute(type: DaemonRequest['type'], clientId: string, action: () => Promise<unknown>) {
    if (observations.has(type)) {
      return action()
    }
    if (
      this.pin &&
      (this.state !== 'released' ||
        this.owner !== clientId ||
        // Failed-start cleanup must not spend the no-effect retry window.
        (type === 'shutdownIfIdle' && !this.effectStarted))
    ) {
      throw new Error('daemon_planned_restart_fenced')
    }
    if (this.pin && !this.effectStarted) {
      // Before the first effect, a lost release ACK is still safely retryable.
      this.effectStarted = true
      this.freezeSessions(false)
    }
    // Register before running action: a synchronous re-entry must also see this effect.
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.inFlight.add(pending)
    try {
      return await action()
    } finally {
      this.inFlight.delete(pending)
      finish()
    }
  }

  async freeze(payload: unknown, clientId: string) {
    const pin = Pin.parse(payload)
    if (
      this.state === 'released' &&
      this.owner === clientId &&
      this.pin?.transitionId !== pin.transitionId
    ) {
      if (this.completed.has(pin.transitionId)) {
        throw new Error('daemon_planned_restart_pin_reused')
      }
      this.completed.add(this.pin!.transitionId)
      this.pin = undefined
    }
    if (this.pin) {
      this.match(pin)
      if (this.owner !== clientId || this.state === 'released') {
        throw new Error('daemon_planned_restart_already_owned')
      }
    } else {
      this.pin = pin
      this.effectStarted = false
      this.owner = clientId
      this.state = 'draining'
      this.drain = Promise.all(this.inFlight).then(() => {
        this.freezeSessions(true)
        this.state = 'frozen'
      })
    }
    await this.drain
    return this.inspect(pin)
  }

  inspect(payload: unknown) {
    this.match(Pin.parse(payload))
    return { transitionId: this.pin!.transitionId, state: this.state }
  }

  release(payload: unknown, clientId: string) {
    this.match(Pin.parse(payload))
    if (this.state === 'released' && this.owner === clientId) {
      return this.inspect(payload)
    }
    if (this.state !== 'frozen' || this.owner === clientId) {
      throw new Error('daemon_planned_restart_successor_required')
    }
    this.owner = clientId
    this.state = 'released'
    return this.inspect(payload)
  }

  disconnected(clientId: string) {
    if (this.owner === clientId && this.state === 'released' && !this.effectStarted) {
      this.state = 'frozen'
    }
  }

  private match(pin: z.infer<typeof Pin>): void {
    if (!this.pin || this.pin.transitionId !== pin.transitionId || this.pin.token !== pin.token) {
      throw new Error('daemon_planned_restart_pin_mismatch')
    }
  }
}
