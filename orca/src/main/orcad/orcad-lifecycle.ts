import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { join } from 'node:path'
import {
  assertStrictContinuityStartup,
  StrictContinuityAdmissionError
} from '../runtime/orchestration/strict-continuity-admission'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { assertOrcadContinuityStartup } from './orcad-continuity-startup'
import { shouldRecordRuntimeLineage } from './orcad-runtime-lineage-host'
import { ORCAD_BUNDLED_LAUNCHER_ENV } from './orcad-bundled-runtime'
import { resolveOrcadExitCode } from './orcad-exit-code'
import {
  admitPlannedSuccessor,
  type PlannedSuccessor,
  type PlannedSuccessorRequest
} from './orcad-planned-successor'
import type { z } from 'zod'
import type { RpcContext } from '../runtime/rpc/core'
import { plannedRestartSourceMaintenance } from './orcad-planned-maintenance'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'

const bundledLauncherChannel = process.env[ORCAD_BUNDLED_LAUNCHER_ENV] === '1'
delete process.env[ORCAD_BUNDLED_LAUNCHER_ENV]

function createIdempotentOrcadCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | null = null
  return () => {
    completion ??= Promise.resolve().then(cleanup)
    return completion
  }
}

export const ORCAD_SHUTDOWN_DEADLINE_MS = 15_000

/** A launcher and its child can both receive the same process-group or service stop signal. */
export function installOrcadShutdownSignals(
  stop: () => Promise<void>,
  deadlineMs = ORCAD_SHUTDOWN_DEADLINE_MS
): void {
  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) {
      return
    }
    stopping = true
    setTimeout(() => {
      console.error(`orcad: shutdown after ${signal} exceeded ${deadlineMs}ms — exiting`)
      process.exit(1)
    }, deadlineMs)
    stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        process.exit(resolveOrcadExitCode(error))
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Headless runtimes survive terminal hangups; INT/TERM are the graceful stop contract.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {})
  }
  if (bundledLauncherChannel && typeof process.send === 'function') {
    process.once('disconnect', () => shutdown('launcher disconnect'))
    if (!process.connected) {
      shutdown('launcher disconnect')
    }
  }
}

export async function startOrcadWithLifecycle<T extends object>(
  start: (registerRuntimeCleanup: (cleanup: () => Promise<void>) => void) => Promise<T>,
  cleanupHost: (runtimeCleanupSucceeded: boolean) => Promise<void>
): Promise<T & { stop(): Promise<void> }> {
  let cleanupRuntime = async (): Promise<void> => {}
  const cleanup = createIdempotentOrcadCleanup(async () => {
    let runtimeCleanupSucceeded = false
    try {
      await cleanupRuntime()
      runtimeCleanupSucceeded = true
    } finally {
      await cleanupHost(runtimeCleanupSucceeded)
    }
  })
  try {
    const handle = await start((nextCleanup) => {
      cleanupRuntime = nextCleanup
    })
    return { ...handle, stop: cleanup }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      // Keep the launch failure as the supervisor-facing verdict; cleanup still needs a breadcrumb.
      console.error('[orcad] startup cleanup failed:', cleanupError)
    }
    throw error
  }
}

/** Keep profile admission until every runtime writer has stopped. */
export async function startOrcadWithHost<T extends object>(
  userDataPath: string,
  start: (
    registerCleanup: (cleanup: () => Promise<void>) => void,
    recordRuntime: (runtime: { getRuntimeId(): string }) => void,
    successor?: PlannedSuccessor,
    maintenance?: (
      freezeProfile: () => Promise<void>
    ) => ((params: unknown, ctx: RpcContext) => Promise<unknown>) | undefined
  ) => Promise<T>,
  runQuitHandlers: () => void,
  plannedRestart?: z.infer<typeof PlannedSuccessorRequest>
): Promise<T & { stop(): Promise<void> }> {
  const instanceLock = acquireOrcadInstanceLock(userDataPath)
  let admission: ProfileStateRuntimeAdmission | undefined
  let browserProvider: Awaited<ReturnType<typeof resolveOrcadBrowserProvider>> | undefined
  let lineage: ReturnType<typeof openOrcadRuntimeLineage> | undefined
  let successor: PlannedSuccessor | undefined
  return startOrcadWithLifecycle(
    async (registerCleanup) => {
      admission = acquireProfileStateRuntimeAdmission(userDataPath)
      if (plannedRestart) {
        lineage = openOrcadRuntimeLineage(userDataPath, instanceLock, { existingOnly: true })
        successor = await admitPlannedSuccessor(userDataPath, lineage, plannedRestart)
      } else {
        assertOrcadContinuityStartup(userDataPath, instanceLock)
        assertStrictContinuityStartup(join(userDataPath, 'orchestration.db'))
      }
      browserProvider = await resolveOrcadBrowserProvider({ userDataPath })
      const provider = browserProvider
      setRuntimeBrowserCommandsFactory(provider?.factory ?? null, {
        headless: provider !== null,
        ...(provider ? { isAvailable: () => provider.isAvailable() } : {})
      })
      return start(
        registerCleanup,
        (runtime) => {
          try {
            if (successor) {
              if (runtime.getRuntimeId() !== successor.runtimeId) {
                throw new Error('planned_restart_runtime_mismatch')
              }
              return
            }
            if (!shouldRecordRuntimeLineage(userDataPath)) {
              return
            }
            lineage ??= openOrcadRuntimeLineage(userDataPath, instanceLock)
            lineage.assertNormalStartup()
            lineage.recordBoot(runtime.getRuntimeId())
          } catch (error) {
            throw new StrictContinuityAdmissionError('Server boot lineage registration failed', {
              cause: error
            })
          }
        },
        successor,
        (freezeProfile) => {
          if (!lineage) {
            return undefined
          }
          return plannedRestartSourceMaintenance(lineage, freezeProfile)
        }
      )
    },
    async (runtimeCleanupSucceeded) => {
      try {
        await browserProvider?.stop()
      } finally {
        setRuntimeBrowserCommandsFactory(null)
        runQuitHandlers()
        try {
          await successor?.close()
        } finally {
          try {
            lineage?.close()
            // Keep admission until the successor DB and its background writers are closed.
            if (runtimeCleanupSucceeded) {
              admission?.release()
            }
          } finally {
            instanceLock.release()
          }
        }
      }
    }
  )
}

export async function flushOrcadProfileStoreForShutdown(store: {
  flushFinalOrThrowAsync(options?: { exportJsonCompatibility?: boolean }): Promise<void>
  freezeWritesAsync(): Promise<void>
}): Promise<void> {
  try {
    await store.flushFinalOrThrowAsync({ exportJsonCompatibility: true })
  } finally {
    await store.freezeWritesAsync()
  }
}
