import { readFileSync } from 'node:fs'
import { z } from 'zod'

const ServerPid = z.number().int().min(2).max(2147483647)

export function serverPidFromMaintenanceEvidence(input: unknown): number {
  const { runtime } = z
    .object({
      runtime: z.object({
        ok: z.literal(true),
        result: z.object({
          target: z.object({ kind: z.literal('local') }),
          app: z.object({ running: z.literal(true), pid: ServerPid }),
          runtime: z.object({ state: z.literal('ready'), runtimeId: z.string().uuid() })
        }),
        _meta: z.object({ runtimeId: z.string().uuid() })
      })
    })
    .parse(input)
  if (runtime.result.runtime.runtimeId !== runtime._meta.runtimeId) {
    throw new Error('administrative_history_runtime_mismatch')
  }
  return runtime.result.app.pid
}

export function assertRunitDown(status: Buffer): void {
  // runit's documented supervise/status layout: pid, wanted state, current state.
  if (
    status.length !== 20 ||
    status.readUInt32LE(12) !== 0 ||
    status[17] !== 100 ||
    status[19] !== 0
  ) {
    throw new Error('administrative_history_service_not_down')
  }
}

export function assertServerMaintenanceStopped(servicePath: string, serverPid: number): void {
  ServerPid.parse(serverPid)
  assertRunitDown(readFileSync(`${servicePath}/supervise/status`))
  let present = true
  try {
    // Signal 0 probes only the native status PID; it sends no signal and scans no processes.
    process.kill(serverPid, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      present = false
    } else {
      throw error
    }
  }
  if (present) {
    throw new Error(`administrative_history_server_process_present:${serverPid}`)
  }
  assertRunitDown(readFileSync(`${servicePath}/supervise/status`))
}
