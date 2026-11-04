import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { OrchestrationDb } from './orchestration/db'
import { assertNoStrictContinuitySeal } from './orchestration/strict-continuity-store'
import { trackStrictContinuityEffect } from './orchestration/strict-continuity-effects'

/** Resolve the DB at each call: controllers can be installed before orchestration is ready. */
export function fenceStrictContinuityPtyController(
  controller: RuntimePtyController,
  getDb: () => OrchestrationDb | null
): RuntimePtyController {
  function effect<T>(invoke: () => T): T {
    const db = getDb()
    if (db) {
      assertNoStrictContinuitySeal(db)
    }
    return trackStrictContinuityEffect(db?.db, invoke)
  }
  function guarded<Args extends unknown[], Result>(method: (...args: Args) => Result) {
    return (...args: Args) => effect(() => method.apply(controller, args))
  }
  return {
    ...controller,
    write: guarded(controller.write),
    kill: guarded(controller.kill),
    ...(controller.spawn && { spawn: guarded(controller.spawn) }),
    ...(controller.writeWithSettlement && {
      writeWithSettlement: guarded(controller.writeWithSettlement)
    }),
    ...(controller.adoptStablePane && { adoptStablePane: guarded(controller.adoptStablePane) }),
    ...(controller.claimStablePaneCreate && {
      claimStablePaneCreate: guarded(controller.claimStablePaneCreate)
    }),
    ...(controller.stopAndWait && { stopAndWait: guarded(controller.stopAndWait) }),
    ...(controller.retireRejectedPty && {
      retireRejectedPty: guarded(controller.retireRejectedPty)
    }),
    ...(controller.recordUnconfirmedStop && {
      recordUnconfirmedStop: guarded(controller.recordUnconfirmedStop)
    }),
    ...(controller.resize && { resize: guarded(controller.resize) }),
    ...(controller.clearBuffer && { clearBuffer: guarded(controller.clearBuffer) }),
    ...(controller.resetInputModes && { resetInputModes: guarded(controller.resetInputModes) })
  }
}
