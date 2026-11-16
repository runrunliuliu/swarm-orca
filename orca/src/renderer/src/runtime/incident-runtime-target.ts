import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { getActiveRuntimeTarget, runtimeTargetForExecutionHostId } from './runtime-client-target'
import type { RuntimeClientTarget } from './runtime-client-target'

export type IncidentRuntimeTarget =
  | RuntimeClientTarget
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }

/** Workspace ownership wins over the legacy global runtime selection. */
export function resolveIncidentRuntimeTarget(
  state: WorktreeOperationRouteState
): IncidentRuntimeTarget {
  let target: IncidentRuntimeTarget
  if (state.activeWorktreeId) {
    const resolution = resolveWorktreeOperationRouteResult(state, state.activeWorktreeId)
    if (resolution.kind !== 'resolved' || resolution.route.executionHostId === null) {
      return { kind: 'unavailable' }
    }
    // SSH/WSL execution hosts do not expose a host-local incident read service.
    target = runtimeTargetForExecutionHostId(resolution.route.executionHostId) ?? {
      kind: 'unsupported'
    }
  } else {
    target = getActiveRuntimeTarget(state.settings ?? null)
  }
  if (
    target.kind === 'environment' &&
    (state.removedRuntimeEnvironmentIds?.has(target.environmentId) ||
      (state.runtimeEnvironmentCatalogHydrated === true &&
        !state.runtimeEnvironments?.some((environment) => environment.id === target.environmentId)))
  ) {
    return { kind: 'unavailable' }
  }
  return target
}
