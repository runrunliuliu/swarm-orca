import { ORCHESTRATION_RUN_METHODS } from './orchestration/runs/runs'
import { STRICT_RUN_CREATE_METHODS } from './orchestration/runs/strict-run-create'
import { START_GRANT_METHODS } from './orchestration/runs/start-grant-methods'
import { STRICT_RUN_RETIRE_METHODS } from './orchestration/runs/strict-run-retire'
import { ORCHESTRATION_WORKER_METHODS } from './orchestration/worker/worker-methods'
import { ORCHESTRATION_FEDERATION_METHODS } from './orchestration/federation/federation-methods'
import { ORCHESTRATION_MUTATION_REQUEST_METHODS } from './orchestration/runs/mutation-request-show'
import { ORCHESTRATION_SEND_METHODS } from './orchestration/messaging/send-methods'
import { ORCHESTRATION_CHECK_METHODS } from './orchestration/messaging/check-methods'
import { ORCHESTRATION_MESSAGE_METHODS } from './orchestration/messaging/message-methods'
import { ORCHESTRATION_DISPATCH_METHODS } from './orchestration/runs/dispatch-methods'
import { ORCHESTRATION_ASK_METHODS } from './orchestration/messaging/ask-methods'
import { ORCHESTRATION_GATE_METHODS } from './orchestration/gates/gates'
import { ORCHESTRATION_RESET_METHODS } from './orchestration/runs/reset-methods'
import { PlannedRestartParams } from '../../../../shared/rpc-contract/planned-restart-params'
import { defineMethod } from '../core'
import { plannedRestartMaintenance } from '../planned-restart-admission'
import { requireStrictTerminalCaller } from '../strict-coordinator-authority'

export const ORCHESTRATION_METHODS = [
  defineMethod({ name: 'orchestration.plannedRestart', params: PlannedRestartParams,
    handler: (params, ctx) => {
      requireStrictTerminalCaller(ctx.runtime, ctx.orchestrationCompatibilityEvidence, params.from)
      return plannedRestartMaintenance(params.request, ctx)
    } }),
  ...STRICT_RUN_CREATE_METHODS,
  ...START_GRANT_METHODS,
  ...STRICT_RUN_RETIRE_METHODS,
  ...ORCHESTRATION_RUN_METHODS,
  ...ORCHESTRATION_WORKER_METHODS,
  ...ORCHESTRATION_FEDERATION_METHODS,
  ...ORCHESTRATION_MUTATION_REQUEST_METHODS,
  ...ORCHESTRATION_SEND_METHODS,
  ...ORCHESTRATION_CHECK_METHODS,
  ...ORCHESTRATION_MESSAGE_METHODS,
  ...ORCHESTRATION_DISPATCH_METHODS,
  ...ORCHESTRATION_ASK_METHODS,
  ...ORCHESTRATION_GATE_METHODS,
  ...ORCHESTRATION_RESET_METHODS
]
