import type { OrcaRuntimeService } from '../orca-runtime'
import { strictCoordinatorRefusal } from '../orchestration/strict-coordinator-policy'
import { isStrictCoordinatorEffect } from './strict-coordinator-effect-scope'
import { withPlannedRestartRequest } from './planned-restart-admission'

const activity = new WeakMap<OrcaRuntimeService, { count: number; exclusive: boolean }>()

function activityFor(runtime: OrcaRuntimeService) {
  let state = activity.get(runtime)
  if (!state) {
    state = { count: 0, exclusive: false }
    activity.set(runtime, state)
  }
  return state
}

// This is process-local admission, not evidence of continuity across a Server restart.
export async function withStrictCoordinatorExclusive<T>(
  runtime: OrcaRuntimeService,
  invoke: () => Promise<T>
): Promise<T> {
  const state = activityFor(runtime)
  if (state.exclusive || state.count > 0) {
    strictCoordinatorRefusal('strict', 'exclusive operation requires quiescent control requests')
  }
  state.exclusive = true
  try {
    return await invoke()
  } finally {
    state.exclusive = false
  }
}

// Cover requests without durable IDs and the whole async invocation, including replay/nudges.
export async function withStrictCoordinatorQuiescence<T>(
  runtime: OrcaRuntimeService,
  method: string,
  params: unknown,
  invoke: () => Promise<T>
): Promise<T> {
  return withPlannedRestartRequest(runtime, method, () => withStrictEffectQuiescence(runtime, method, params, invoke))
}

async function withStrictEffectQuiescence<T>(runtime: OrcaRuntimeService, method: string, params: unknown, invoke: () => Promise<T>): Promise<T> {
  if (!isStrictCoordinatorEffect(method, params)) {
    return invoke()
  }
  if (method === 'orchestration.runRetireStrict') {
    return withStrictCoordinatorExclusive(runtime, invoke)
  }
  const state = activityFor(runtime)
  if (state.exclusive) {
    strictCoordinatorRefusal('strict', 'exclusive control operation is in progress')
  }
  state.count++
  try {
    return await invoke()
  } finally {
    state.count--
  }
}
