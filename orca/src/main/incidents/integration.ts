// The one door the rest of Orca uses to reach the incidents module (boundary freeze, B1).
//
// Why this file exists
// --------------------
// `incidents/` is written as a self-contained module so it can be split out physically later. Ten
// upstream files are different from the other importers, and the difference is not cosmetic: they sit
// on code paths Orca's *own* upstream changes touch routinely (PTY exit wiring, the orchestration
// settlement chain, startup services, the structured agent-session host). Every time upstream
// re-imports or reshuffles one of those files, a deep `incidents/<internal>.ts` import is a conflict
// and a review question. Routing them through one stable specifier means an internal rename is a
// change here, and an upstream re-import is a change to one line that touches no incidents internals.
//
// The other importers (`cli/`, our own `main/` files and tests) are deliberately NOT routed through
// this file: they evolve with the module and should see it directly.
//
// Rules for this file
// -------------------
//   * only the symbols those ten files actually use — no `export *`, no whole-module re-export;
//   * grouped by the internal module they come from, so a rename is a one-line edit plus a reason;
//   * nothing else may be added here without adding it to the boundary test's pinned list
//     (`incident-integration-boundary.test.ts`), which fails when the set drifts in either direction.

// `main/runtime/orca-runtime-on-pty-exit.ts` — the PTY exit writer and its epoch fallback.
export { recordPtyExitIncident } from './incident-writer'
export { fallbackPtyIncarnationId } from './incident-key'

// The orchestration settlement chain: `dispatch-completion`, `worker-report-settlement`,
// `federation-relay-import`, `legacy-lifecycle-operation`, `lifecycle-reconciliation`,
// `rpc/methods/orchestration/messaging/send-methods`.
export {
  decideMaintenanceAcceptance,
  decideWorkerReportAcceptance,
  evaluateAcceptanceForDispatch,
  logAcceptanceBlocked
} from './acceptance-runtime'
export type { AcceptanceDecision } from './acceptance-runtime'

// `main/startup/main-process-ready-foundation.ts`.
export { scheduleIncidentShadowReconcile } from './incidents-startup'

// `main/startup/main-process-ready-foundation.ts` and `main/startup/main-process-runtime-service.ts`.
export { configureStallSamplerSource, startStallSampler } from './incidents-stall-sampler-timer'
export { stallRowsFromStatusSnapshot } from './incidents-stall-sampler'

// `main/native-chat/agent-session-wire/structured-agent-session-host-runtime-state.ts`.
export { observeToolErrorItem } from './incident-tool-error-observer'
