import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../../../../shared/agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../../../../../../shared/agent-session-option-launch'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
  backendVariant?: string
}

export type OrchestrationWorkerLaunchReceipt = {
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  backendVariant?: string
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null,
    ...(args.backendVariant ? { backendVariant: args.backendVariant } : {})
  }
  return { requested: selection, effective: { ...selection } }
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  backendVariant?: string
}): OrchestrationWorkerLaunchReceipt {
  return {
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      effort: args.effort ?? null,
      ...(args.backendVariant ? { backendVariant: args.backendVariant } : {})
    },
    effective: null
  }
}

export function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  model?: string
  effort?: string
  backendVariant?: string
}): {
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
} {
  if (args.effort && !args.model) {
    throw new OrchestrationError('invalid_argument', '--effort requires --model.')
  }
  if (args.backendVariant && !args.model) {
    throw new OrchestrationError('invalid_argument', '--backend-variant requires --model.')
  }
  if (!args.model) {
    return {
      preferences: undefined,
      receipt: createWorkerLaunchReceipt({ agent: args.agent })
    }
  }
  // The Swarm profile supplies Standard; omission here can inherit an incompatible Max.
  if (args.agent === 'trae' && args.model === 'gpt-5.4' && !args.backendVariant) {
    throw new OrchestrationError(
      'invalid_argument',
      'Trae gpt-5.4 workers require explicit --backend-variant standard; inherited Max is unsupported.'
    )
  }

  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} does not support launch-time model selection. Omit --model to run the model from its own config.`
    )
  }

  for (const key of ['effort', 'backendVariant'] as const) {
    const value = args[key]
    if (!value) {
      continue
    }
    const model = findCatalogModel(catalog, args.model)
    const option =
      findCatalogOption(model, key) ??
      (!model ? catalog.unknownModelOptions?.find((candidate) => candidate.id === key) : undefined)
    if (
      option?.kind.type !== 'select' ||
      !option.kind.choices.some((choice) => choice.value === value)
    ) {
      throw new OrchestrationError(
        'invalid_argument',
        `Agent ${args.agent} model ${args.model} does not support ${key} ${value}.`
      )
    }
  }

  const requested = {
    model: args.model,
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.backendVariant ? { backendVariant: args.backendVariant } : {})
  }
  const resolved = resolveAgentSessionOptionLaunch(args.agent, requested, [], false)
  if (
    resolved.appliedValues.model !== args.model ||
    resolved.appliedValues.effort !== args.effort ||
    resolved.appliedValues.backendVariant !== args.backendVariant
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} cannot apply the requested worker launch preferences.`
    )
  }

  const preferences: AgentLaunchPreferences = requested
  return {
    preferences,
    receipt: createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
  }
}

export function assertWorkerLaunchPreferencesCreateTerminal(args: {
  terminal?: string
  model?: string
  effort?: string
  backendVariant?: string
}): void {
  if (args.terminal && (args.model || args.effort || args.backendVariant)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--model, --effort and --backend-variant cannot be applied when reusing an existing terminal.'
    )
  }
}

export function assertWorkerLaunchPreferencesRuntimeSupported(args: {
  agent?: string
  model?: string
  effort?: string
  backendVariant?: string
  capabilities?: readonly string[]
  serverName: string
}): void {
  if (
    (args.model || args.effort || args.backendVariant) &&
    !args.capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support worker model or effort overrides.`
    )
  }
  if (
    (args.backendVariant || (args.agent === 'trae' && (args.model || args.effort))) &&
    !args.capabilities?.includes(TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support Trae worker launch overrides.`
    )
  }
}

export function resolveFederatedWorkerLaunchReceipt(
  remote: OrchestrationWorkerLaunchReceipt | undefined,
  requested: OrchestrationWorkerLaunchReceipt,
  remoteReady: boolean
): OrchestrationWorkerLaunchReceipt {
  const selection = requested.requested
  if (
    remoteReady &&
    (selection.backendVariant || (selection.agent === 'trae' && selection.model))
  ) {
    if (
      !remote?.effective ||
      (['agent', 'model', 'effort', 'backendVariant'] as const).some(
        (key) => remote.effective?.[key] !== selection[key]
      )
    ) {
      throw new Error('The worker server did not confirm the requested Trae launch preferences.')
    }
  }
  if (remote) {
    return remote
  }
  return remoteReady
    ? { requested: requested.requested, effective: { ...requested.requested } }
    : requested
}
