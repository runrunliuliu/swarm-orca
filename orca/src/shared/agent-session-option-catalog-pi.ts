import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

/** Pi takes one opaque `--model <provider>/<id>` selector whose ids are account-scoped, so seed
 *  nothing (no picker) and let worker-start pass the caller's exact selector through.
 *  Why no effort/backend options: Pi's `--thinking` ladder is not a Trae Max variant, so a
 *  Trae effort/backend value must be refused here instead of silently rewritten. */
export const PI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model'])
  }
}
