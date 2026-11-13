import { defineMethod } from '../../../core'
import {
  RunCreateGrantedParams,
  RunCreateParams,
  RunCurrentParams
} from '../../../../../../shared/rpc-contract/orchestration-runs-params'
import { requireStrictTerminalCaller } from '../../../strict-coordinator-authority'
import { hashCanonical } from '../../../orchestration-mutation-receipt'
import { exposeRun } from './run-receipt'

// A distinct verb makes new-client/old-server activation fail instead of stripping an optional flag.
export const STRICT_RUN_CREATE_METHODS = [
  defineMethod({
    name: 'orchestration.strictCallerCheck',
    params: RunCurrentParams,
    handler: (params, ctx) => {
      const proof = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence,
        params.from
      )
      // No DB access, binding, lease, or reusable credential. runCreateStrict must
      // verify the live proof again: this observation is not launch authorization.
      return {
        coordinatorPolicy: 'strict-v1' as const,
        caller: {
          terminalHandle: proof.terminalHandle,
          paneKey: proof.paneKey,
          processIncarnation: proof.processIncarnation,
          hostScope: proof.hostScope,
          // Public comparison pin only; never accepted as request evidence.
          authorityFingerprint: hashCanonical(proof)
        },
        checkedAt: new Date().toISOString(),
        effectsApplied: false as const
      }
    }
  }),
  defineMethod({
    name: 'orchestration.runCreateGranted',
    params: RunCreateGrantedParams,
    handler: (params, ctx) => {
      const authority = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence,
        params.from
      )
      const db = ctx.runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(authority.paneKey)
      const { run, replayed } = db.createGrantedRun({
        objective: params.objective,
        coordinatorHandle: authority.terminalHandle,
        coordinatorPaneKey: authority.paneKey,
        strictCoordinator: authority,
        startGrant: { grantId: params.grant, authority }
      })
      // A replay wrote nothing, so waking waiters would be the only effect it had.
      if (!replayed) {
        ctx.runtime.cancelMessageWaiters(authority.terminalHandle)
        if (priorRun) {
          ctx.runtime.cancelMessageWaiters(`run:${priorRun.id}`)
        }
      }
      return {
        run: exposeRun(run),
        coordinatorPolicy: 'strict-v1' as const,
        effectsApplied: !replayed
      }
    }
  }),
  defineMethod({
    name: 'orchestration.runCreateStrict',
    params: RunCreateParams,
    handler: (params, ctx) => {
      const authority = requireStrictTerminalCaller(
        ctx.runtime,
        ctx.orchestrationCompatibilityEvidence,
        params.from
      )
      const db = ctx.runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(authority.paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: authority.terminalHandle,
        coordinatorPaneKey: authority.paneKey,
        strictCoordinator: authority
      })
      ctx.runtime.cancelMessageWaiters(authority.terminalHandle)
      if (priorRun) {
        ctx.runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run: exposeRun(run), coordinatorPolicy: 'strict-v1' as const }
    }
  })
]
