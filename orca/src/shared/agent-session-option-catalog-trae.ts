import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import {
  hasAgentConfigOverride,
  removeAgentConfigOverride
} from './agent-session-option-config-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

function traeConfigOption(
  id: string,
  key: string,
  label: string,
  ...values: string[]
): CatalogOption {
  return {
    id,
    label,
    kind: {
      type: 'select',
      choices: [
        { value: '', label: 'Use Trae config' },
        ...values.map((value) => ({ value, label: value }))
      ],
      defaultValue: ''
    },
    apply: {
      launchArgs: (selection) =>
        selection ? ['-c', `${key}=${JSON.stringify(String(selection))}`] : [],
      agentArgsOverride: (tokens) => hasAgentConfigOverride(tokens, key),
      removeAgentArgs: (tokens) => removeAgentConfigOverride(tokens, key)
    }
  }
}

const EFFORT = traeConfigOption('effort', 'model_reasoning_effort', 'Reasoning effort', 'high')
// Trae's GPT-5.4 catalog supports these reasoning levels, but not Max.
const GPT54_EFFORT = traeConfigOption(
  'effort',
  'model_reasoning_effort',
  'Reasoning effort',
  'low',
  'medium',
  'high',
  'xhigh'
)
const BACKEND_VARIANT = traeConfigOption(
  'backendVariant',
  'model_backend_variant',
  'Independent Max',
  'max'
)
const GPT54_BACKEND_VARIANT = traeConfigOption(
  'backendVariant',
  'model_backend_variant',
  'Backend variant',
  'standard'
)

export const TRAE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Only verified per-model overrides are offered; model-only launches retain Trae's defaults.
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', options: [EFFORT, BACKEND_VARIANT] },
    { id: 'gpt-5.5', label: 'GPT-5.5', options: [EFFORT, BACKEND_VARIANT] },
    { id: 'gpt-5.4', label: 'GPT-5.4', options: [GPT54_EFFORT, GPT54_BACKEND_VARIANT] },
    { id: 'DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash', options: [EFFORT] },
    { id: 'DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash', options: [BACKEND_VARIANT] },
    { id: 'example-provider-model', label: 'Example Provider Model', options: [] }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) =>
      hasFlag(tokens, ['-m', '--model']) || hasAgentConfigOverride(tokens, 'model'),
    removeAgentArgs: (tokens) =>
      removeAgentConfigOverride(removeAgentArgOption(tokens, ['-m', '--model']), 'model')
  }
}
