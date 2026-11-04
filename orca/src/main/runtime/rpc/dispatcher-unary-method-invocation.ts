import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcContext, RpcMethod, RpcRequest } from './core'
import { routeDispatcherClientHostedBrowserRpc } from './dispatcher-client-browser-routing'
import { needsLocalCallerFingerprint } from './dispatcher-caller-fingerprint'
import type { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import type {
  DurableMutationInvocation,
  OrchestrationMutationExecutor
} from './orchestration-mutation-executor'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import { assertStrictCoordinatorRequest } from './strict-coordinator-request'
import { withStrictCoordinatorQuiescence } from './strict-coordinator-quiescence'

type DispatcherUnaryMethodInvocation = {
  runtime: OrcaRuntimeService
  request: RpcRequest
  method: RpcMethod
  params: unknown
  context: RpcContext
  orchestrationMutations: OrchestrationMutationExecutor
  legacyOrchestration: OrchestrationLegacyCompatibility
}

export function invokeDispatcherUnaryMethod(
  args: DispatcherUnaryMethodInvocation
): Promise<unknown> {
  return withStrictCoordinatorQuiescence(args.runtime, args.request.method, args.params, () =>
    invokeQuiescenceTrackedMethod(args)
  )
}

async function invokeQuiescenceTrackedMethod({
  runtime,
  request,
  method,
  params,
  context,
  orchestrationMutations,
  legacyOrchestration
}: DispatcherUnaryMethodInvocation): Promise<unknown> {
  assertStrictCoordinatorRequest(request.method, params, {
    ...context,
    orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
  })
  const clientHostedBrowser = await routeDispatcherClientHostedBrowserRpc(
    runtime,
    request.method,
    params
  )
  if (clientHostedBrowser.handled) {
    recordRuntimeFeatureInteraction(
      runtime,
      request.method,
      clientHostedBrowser.result,
      undefined,
      request.params
    )
    return clientHostedBrowser.result
  }

  const compatibility = await legacyOrchestration.tryHandle(request, params, context.signal)
  if (compatibility.handled) {
    return compatibility.result
  }
  const effectiveParams = compatibility.params ?? params
  const legacyCoordinator = legacyOrchestration.createCoordinatorInvocation(
    request,
    compatibility.legacyCoordinatorAuthority
  )
  const authenticatedCallerFingerprint =
    context.authenticatedCallerFingerprint ??
    legacyCoordinator?.mutationCallerFingerprint ??
    (needsLocalCallerFingerprint(request, effectiveParams)
      ? orchestrationMutations.getLocalAuthenticatedCallerFingerprint()
      : undefined)
  const invoke = (mutation?: DurableMutationInvocation) => {
    assertStrictCoordinatorRequest(request.method, effectiveParams, {
      ...context,
      orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
    })
    const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
    return method.handler(effectiveParams, {
      ...context,
      authenticatedCallerFingerprint:
        mutation?.identity.callerFingerprint ?? authenticatedCallerFingerprint,
      recordMutationReceipt: mutation?.recordReceipt,
      markWorkerDoneMutationEffectFree: mutation?.markWorkerDoneEffectFree,
      markMutationEffectPossible: mutation?.markEffectPossible,
      orchestrationMutation: mutation?.identity,
      replayedMutationReceipt: mutation?.replayedReceipt,
      legacyCoordinatorRunId,
      legacyCoordinatorAuthority: legacyCoordinator?.authority,
      revalidateLegacyCoordinator: legacyCoordinator?.revalidate,
      orchestrationCompatibilityCallerAuthority:
        compatibility.orchestrationCompatibilityCallerAuthority,
      orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
    })
  }
  const result = await orchestrationMutations.run(
    request,
    effectiveParams,
    invoke,
    legacyCoordinator?.mutationCallerFingerprint ?? authenticatedCallerFingerprint,
    context.orchestrationCaller?.orcaSessionId
  )
  recordRuntimeFeatureInteraction(runtime, request.method, result, undefined, request.params)
  return result
}
