import { z } from 'zod'
import type { DaemonClient } from './client'
import { sameDaemonIdentity } from './daemon-client-hello-handshake'

export const DaemonRestartPinSchema = z
  .object({
    daemon: z
      .object({
        pid: z.number().int().positive(),
        startedAtMs: z.number().nonnegative(),
        launchNonce: z.string().min(1),
        entryPath: z.string().optional(),
        appVersion: z.string().optional(),
        spawnerExecPath: z.string().optional()
      })
      .strict(),
    transitionId: z.string().uuid(),
    token: z.string().uuid()
  })
  .strict()
export type DaemonRestartPin = z.infer<typeof DaemonRestartPinSchema>

const Result = z
  .object({
    transitionId: z.string().uuid(),
    state: z.enum(['draining', 'frozen', 'released'])
  })
  .strict()

/** Capability probe uses a new request, never a flag an older daemon may ignore. */
export async function plannedRestartDaemonRequest(
  client: DaemonClient,
  phase: 'Freeze' | 'Inspect' | 'Release',
  pin: DaemonRestartPin
) {
  await client.ensureConnected()
  if (!sameDaemonIdentity(client.getDaemonIdentity(), pin.daemon)) {
    throw new Error('daemon_planned_restart_identity_changed')
  }
  const result = Result.parse(
    await client.request(`plannedRestart${phase}`, {
      transitionId: pin.transitionId,
      token: pin.token
    })
  )
  if (
    result.transitionId !== pin.transitionId ||
    !sameDaemonIdentity(client.getDaemonIdentity(), pin.daemon) ||
    (phase === 'Freeze' && result.state !== 'frozen') ||
    (phase === 'Release' && result.state !== 'released')
  ) {
    throw new Error('daemon_planned_restart_unconfirmed')
  }
  return result
}
