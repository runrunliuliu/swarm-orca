/**
 * Pure degradation decisions for the workbench shell (p1a-ui-shell-plan.md §2.1,
 * R19). No React, no `window`, no `matchMedia`, no I/O: P1a calls this with
 * fixture sizes, P1b with a `ResizeObserver`-measured container.
 *
 * The sacrifice order is fixed by README §7.3.1: Workspaces identity and its
 * primary action are never sacrificed; Delivery goes first, then agent history,
 * then Spend detail.
 */

/** Design assumption, calibrated by P1a's S1–S3 plus the 900×700 and 1280×479
 *  probes: S2/S3 prove the inclusive boundary (exactly 1100 is still double
 *  column, exactly 480 is not yet short), the probes prove the degraded
 *  branches. README §7.3.1 is the normative rule; the value did not change. */
export const TASK_WORKBENCH_NARROW_WIDTH = 1100

/** See `TASK_WORKBENCH_NARROW_WIDTH`: calibrated, unchanged, and inclusive —
 *  exactly 480 is not short. */
export const TASK_WORKBENCH_SHORT_HEIGHT = 480

export type TaskWorkbenchLayoutInput = {
  containerWidth: number
  containerHeight: number
  counts: {
    workspaces: number
    agents: number
    activeAgents: number
    attentionAgents: number
    historyAgents: number
  }
  /** P1a renders one fixed size per fixture; P1b measures the live container.
   *  The decision function ignores this field — it exists so callers declare
   *  where the size came from, and a future hysteresis can branch on it. */
  mode: 'static' | 'live'
}

export type TaskWorkbenchLayout = {
  columns: 'single' | 'double'
  delivery: 'expanded' | 'collapsed'
  agentHistory: 'expanded' | 'collapsed'
  spend: 'full' | 'summary'
  workspaces: 'full' | 'compact' | 'empty'
}

/**
 * Total and deterministic: every input produces a decision, including zero
 * counts and a zero-sized container. Boundaries are inclusive where the rule
 * table says so — exactly `TASK_WORKBENCH_NARROW_WIDTH` is still double column,
 * exactly `TASK_WORKBENCH_SHORT_HEIGHT` is not short.
 */
export function computeTaskWorkbenchLayout(
  input: TaskWorkbenchLayoutInput
): TaskWorkbenchLayout {
  const narrow = input.containerWidth < TASK_WORKBENCH_NARROW_WIDTH
  const short = input.containerHeight < TASK_WORKBENCH_SHORT_HEIGHT
  const noWorkspaces = input.counts.workspaces === 0

  return {
    columns: narrow ? 'single' : 'double',
    workspaces: noWorkspaces ? 'empty' : short ? 'compact' : 'full',
    // Delivery is the first thing sacrificed, so it also collapses when there is
    // no workspace evidence to show.
    delivery: narrow || short || noWorkspaces ? 'collapsed' : 'expanded',
    // History detail is sacrificed before Spend detail but after Delivery.
    agentHistory: short || input.counts.historyAgents >= 10 ? 'collapsed' : 'expanded',
    spend: narrow || short || noWorkspaces ? 'summary' : 'full'
  }
}
