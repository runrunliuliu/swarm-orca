import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcContext } from './core'

export type PlannedRestartMaintenance = (params: unknown, ctx: RpcContext) => Promise<unknown>
const hosts = new WeakMap<OrcaRuntimeService, PlannedRestartMaintenance>()
const activity = new WeakMap<OrcaRuntimeService, { count: number; frozen: boolean }>()

export function fencePlannedRestartStartup(runtime: OrcaRuntimeService) {
  if (activity.has(runtime)) {
    throw new Error('planned_restart_startup_already_active')
  }
  const state = { count: 0, frozen: true }
  activity.set(runtime, state)
  return () => {
    state.frozen = false
  }
}

export function installPlannedRestartMaintenance(
  runtime: OrcaRuntimeService,
  handler: PlannedRestartMaintenance
) {
  hosts.set(runtime, handler)
  return () => hosts.delete(runtime)
}

export function installPlannedRestartHandlers(
  runtime: OrcaRuntimeService,
  source: PlannedRestartMaintenance,
  target?: PlannedRestartMaintenance
) {
  return installPlannedRestartMaintenance(runtime, (params, ctx) => {
    const phase =
      params && typeof params === 'object' && 'phase' in params ? params.phase : undefined
    return target && (phase === 'transition' || phase === 'boundary')
      ? target(params, ctx)
      : source(params, ctx)
  })
}

export function plannedRestartMaintenance(params: unknown, ctx: RpcContext) {
  const handler = hosts.get(ctx.runtime)
  if (!handler) {
    throw new Error('planned_restart_unsupported_host')
  }
  return handler(params, ctx)
}

export function freezePlannedRestartRequests(runtime: OrcaRuntimeService) {
  const state = activity.get(runtime)
  if (!state || state.count !== 1 || state.frozen) {
    throw new Error('planned_restart_requests_not_quiescent')
  }
  state.frozen = true
}

/** Include non-strict and streaming calls; seal cannot race provisioning or a mobile resume. */
export async function withPlannedRestartRequest<T>(
  runtime: OrcaRuntimeService,
  method: string,
  invoke: () => Promise<T>
) {
  let state = activity.get(runtime)
  if (!state) {
    state = { count: 0, frozen: false }
    activity.set(runtime, state)
  }
  if (
    state.frozen &&
    method !== 'orchestration.plannedRestart' &&
    method !== 'orchestration.strictCallerCheck'
  ) {
    throw new Error('planned_restart_server_frozen')
  }
  state.count++
  try {
    return await invoke()
  } finally {
    state.count--
  }
}
