import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRepeatedStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_SPARSE_CHECKOUT_RUNTIME_CAPABILITY,
  TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  TRAE_WORKER_WRITABLE_ROOTS_CAPABILITY
} from '../../../shared/protocol-version'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { formatWorkerStart } from './worker-output'
import { renderResolvedOrchestrationCommand } from '../../orchestration-mutation-recovery'
import { parseWorkerWritableRootsFlag } from './worker-writable-roots-flag'
import { validateWorkerPlacementFlags } from './worker-placement-flags'

export const ORCHESTRATION_WORKER_LAUNCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration worker-start': async ({ flags, client, cwd, json }) => {
    validateWorkerPlacementFlags(flags)
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    const agent = getOptionalStringFlag(flags, 'agent')
    const backendVariant = getOptionalStringFlag(flags, 'backend-variant')
    const sparseDirectories = getRepeatedStringFlag(flags, 'sparse-dir')
    const writableRoots = parseWorkerWritableRootsFlag(
      getOptionalStringFlag(flags, 'writable-roots')
    )
    if (model || effort || backendVariant || writableRoots || sparseDirectories.length > 0) {
      const status = await client.call<RuntimeStatus>('status.get')
      if (
        (model || effort || backendVariant) &&
        !status.result.capabilities?.includes(
          ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
        )
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support worker model or effort overrides. Update or restart Orca and try again.'
        )
      }
      if (
        ((agent === 'trae' && (model || effort)) || backendVariant) &&
        !status.result.capabilities?.includes(TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support Trae worker launch overrides. Update the runtime before starting this worker.'
        )
      }
      if (
        writableRoots &&
        !status.result.capabilities?.includes(TRAE_WORKER_WRITABLE_ROOTS_CAPABILITY)
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support Trae worker writable roots. No worker was started.'
        )
      }
      if (
        sparseDirectories.length > 0 &&
        !status.result.capabilities?.includes(ORCHESTRATION_WORKER_SPARSE_CHECKOUT_RUNTIME_CAPABILITY)
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support sparse checkout worker creation. Update or restart Orca and try again.'
        )
      }
    }
    const task = getOptionalStringFlag(flags, 'task')
    const spec = getOptionalStringFlag(flags, 'spec')
    const taskTitle = getOptionalStringFlag(flags, 'task-title')
    const deps = getOptionalStringFlag(flags, 'deps')
    const parent = getOptionalStringFlag(flags, 'parent')
    const result = await callOrchestrationMutation<{
      runId: string
      taskId: string
      dispatchId: string
      state: string
      failedStage?: string
      lastError?: string
      warning?: string
      mode?: { mode: string; preferred: string; reason: string; detail: string }
      effects: unknown[]
      residualResources: unknown[]
      nextCommands?: string[]
    }>(client, flags, 'orchestration.workerStart', {
      task,
      ...(spec ? { spec } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      ...(deps ? { deps } : {}),
      ...(parent ? { parent } : {}),
      on: getOptionalStringFlag(flags, 'on'),
      worktree: getOptionalStringFlag(flags, 'worktree'),
      name: getOptionalStringFlag(flags, 'name'),
      repo: getOptionalStringFlag(flags, 'repo'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      comment: getOptionalStringFlag(flags, 'comment'),
      setup: getOptionalStringFlag(flags, 'setup'),
      ...(sparseDirectories.length > 0 ? { sparseDirectories } : {}),
      agent,
      model,
      effort,
      backendVariant,
      ...(writableRoots ? { writableRoots } : {}),
      terminal: getOptionalStringFlag(flags, 'terminal'),
      retryOf: getOptionalStringFlag(flags, 'retry-of'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
      devMode: isDevCliInvocation()
    })
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    const renderedResult = result.result.nextCommands
      ? {
          ...result,
          result: {
            ...result.result,
            nextCommands: result.result.nextCommands.map((command) =>
              renderResolvedOrchestrationCommand(command)
            )
          }
        }
      : result
    printResult(renderedResult, json, formatWorkerStart)
  }
}
