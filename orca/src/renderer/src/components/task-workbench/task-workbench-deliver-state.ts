import { isTaskWorkbenchDeliverSessionName } from './task-workbench-deliver-session'
import type { AgentRowView, TaskWorkbenchView, TaskWorkbenchWorkspace } from './task-workbench-view'

/**
 * The delivery entry's state and its one action descriptor (README §7.11.3
 * rule 4, §7.11.5), projected from fields the workbench already has.
 *
 * Why this is a pure module: the same six states are read by two different
 * hosts (the Delivery fact row and the sidebar workspace context menu), and the
 * state must not depend on which host asked. Deriving it once here means the two
 * entries cannot drift, and it keeps the rule "an archived row never gets a
 * delivery entry" testable without rendering anything.
 *
 * What it deliberately does not do:
 * - no new field. `DeliveryEvidence` carries commits / PR / checks / review and
 *   nothing else, so the `注意` (uncommitted / unpushed) line has no source and
 *   is empty in every state. That absence is the honest answer; a guessed line
 *   would be a fabricated fact (README §7.11.6).
 * - no number and no state word. A count is not copied into the projection and
 *   a disabled reason is a locale key plus its English fallback, taken from the
 *   frozen vocabulary. "Unknown" never becomes `0` (README §7.5).
 * - no React, store, RPC, IPC, runtime, Electron or `git` import. The workbench
 *   import-boundary test pins this, and a pure projection needs no mock.
 *
 * Eligibility (§7.11.3 rule 7, A9): the repository's own checkout and a folder
 * workspace are never delivery targets. The sidebar already excludes them from
 * its archivable set; here the same rule is applied to *choosing* a target, so
 * the task-page entry cannot hand the primary checkout to a delivery agent.
 * When nothing deliverable is left, the projection's `none` action is the whole
 * answer: the entry's absence means "no deliverable workspace", not "unknown".
 */

/** Why `has-evidence` is a seventh kind and not a sixth: the frozen vocabulary
 *  names the two *absences* of evidence (`evidence-not-read` = nothing was read,
 *  `zero-evidence` = read, and it found zero commits and no PR). The state a
 *  reader needs when there *is* evidence is neither, so it gets its own kind
 *  instead of being mislabelled with one of them. The acceptance rows only need
 *  the six names above/below this one; the action is `deliver` + enabled in all
 *  three evidence states. */
export type TaskWorkbenchDeliverStateKind =
  | 'no-workspace'
  | 'archived'
  | 'one-writer'
  | 'deliver-session'
  | 'evidence-not-read'
  | 'zero-evidence'
  | 'has-evidence'

/** A sentence the module may render: the locale key plus the English fallback,
 *  exactly the shape the rest of the workbench uses. Never a bare string, so a
 *  host cannot forget the key, and never a count, so nothing can be invented. */
export type TaskWorkbenchDeliverNotice = { key: string; fallback: string }

/** One action, four shapes. `deliver` with `enabled: false` carries the reason
 *  the hosts put on `title` + `sr-only` (task-workbench-pending-action.tsx). */
export type TaskWorkbenchDeliverAction =
  | { kind: 'none' }
  | { kind: 'deliver'; enabled: false; disabledReason: TaskWorkbenchDeliverNotice }
  | { kind: 'deliver'; enabled: true }
  | { kind: 'open-terminal'; paneKey: string }

export type TaskWorkbenchDeliverProjection = {
  state: TaskWorkbenchDeliverStateKind
  /** The workspace the action would target, when one resolved. Present for
   *  `archived` too: the state, not a missing id, is what hides the entry. */
  workspaceId?: string
  action: TaskWorkbenchDeliverAction
  /** Rows of the `注意` line. Empty today — see the module comment and the
   *  reported gap in README §7.11.6. Its presence must never change `action`. */
  attention: readonly TaskWorkbenchDeliverNotice[]
}

/** Frozen key and fallback (SHARED-CONTEXT). Rule 4 / A5: one writer. */
const DISABLED_WORKING: TaskWorkbenchDeliverNotice = {
  key: 'auto.components.TaskWorkbenchDeliver.disabledWorking',
  fallback: 'A working agent already owns this workspace; delivery waits for one writer.'
}

const NONE: TaskWorkbenchDeliverAction = { kind: 'none' }
const DELIVER_ENABLED: TaskWorkbenchDeliverAction = { kind: 'deliver', enabled: true }

/** §7.11.3 rule 7 / A9: the agent hosts in the delivered workspace, never in the
 *  repository's own checkout, and a folder workspace is not a git worktree to
 *  deliver from. Both are facts the view already carries (the sidebar's own
 *  `archivableWorktrees` filter reads the same two). */
function isDeliverableTarget(workspace: TaskWorkbenchWorkspace): boolean {
  return workspace.isMainWorktree !== true && workspace.workspaceKind !== 'folder'
}

/**
 * Which workspace the action targets.
 *
 * An explicit id wins (that is the sidebar clicking one row). Without one, the
 * task's default workspace is preferred **only when it resolves to a live,
 * deliverable workspace**; otherwise the first live deliverable one.
 * `defaultWorkspace.source` is not consulted and not upgraded —
 * `recent-activity` must never masquerade as a user's choice (README §7.5), so
 * the projection never emits a "primary".
 *
 * Ineligible rows are skipped, not relabelled: a main checkout or a folder
 * workspace is never selected, and an explicit id naming one yields no target
 * at all (the entry's absence means "no deliverable workspace").
 *
 * No deliverable live workspace falls back to an archived one so the caller can
 * say `archived` instead of `no-workspace` (the issue #31 history case); only
 * when the task has no workspace, or none that may be delivered, does
 * `no-workspace` apply.
 */
function resolveWorkspace(
  view: TaskWorkbenchView,
  explicitWorkspaceId?: string
): TaskWorkbenchWorkspace | undefined {
  const byId = (id: string): TaskWorkbenchWorkspace | undefined =>
    view.workspaces.find((workspace) => workspace.worktreeId === id)

  if (explicitWorkspaceId !== undefined) {
    // An unresolved explicit id is not a licence to deliver somewhere else, and
    // neither is an ineligible one (main checkout / folder).
    const explicit = byId(explicitWorkspaceId)
    if (!explicit) {
      return undefined
    }
    if (explicit.archived === true) {
      return explicit
    }
    return isDeliverableTarget(explicit) ? explicit : undefined
  }

  const preferred = byId(view.defaultWorkspace.workspaceId)
  if (preferred && preferred.archived !== true && isDeliverableTarget(preferred)) {
    return preferred
  }
  const live = view.workspaces.find(
    (workspace) => workspace.archived !== true && isDeliverableTarget(workspace)
  )
  if (live) {
    return live
  }
  // No deliverable live row: the archived default (then the first archived row)
  // lets the caller say `archived` rather than `no-workspace`. A live main
  // checkout is not a fallback here — that is the A9 rule above.
  if (preferred?.archived === true) {
    return preferred
  }
  return view.workspaces.find((workspace) => workspace.archived === true)
}

/** The rows that may speak for this workspace. A row of an archived workspace is
 *  history whatever its bucket still says (README §7.10), so it is neither the
 *  working writer nor the existing delivery session. */
function rowsOf(workspace: TaskWorkbenchWorkspace, agents: AgentRowView[]): AgentRowView[] {
  return agents.filter(
    (row) => row.archivedWorkspace !== true && row.base.worktreeId === workspace.worktreeId
  )
}

/**
 * The one projection both delivery entries render from.
 *
 * Precedence, and why:
 * 1. no deliverable workspace (none at all, or only a main checkout / folder)
 *    → nothing to deliver to (`none`)
 * 2. archived → history, never a delivery entry (`none`)
 * 3. an existing `DELIVER` session → `[ 打开终端 ]`; it is the thing to open,
 *    so it outranks the one-writer reason (rule 4 explicitly orders these)
 * 4. a working row → `[ 交付… ]` disabled with the frozen reason
 * 5. evidence: not read / read-and-empty / read-with-facts, all `[ 交付… ]`
 *    enabled — the delivery entry is a hand-off, not a claim about the result.
 */
export function projectTaskWorkbenchDeliver(
  view: TaskWorkbenchView,
  workspaceId?: string
): TaskWorkbenchDeliverProjection {
  const attention: readonly TaskWorkbenchDeliverNotice[] = []
  const workspace = resolveWorkspace(view, workspaceId)
  if (!workspace) {
    return { state: 'no-workspace', action: NONE, attention }
  }
  const target = { workspaceId: workspace.worktreeId, attention }
  if (workspace.archived === true) {
    return { state: 'archived', ...target, action: NONE }
  }

  const rows = rowsOf(workspace, view.agents)
  // First match wins: the rows arrive in the view's own order, so two markers
  // cannot make the entry flicker between two panes across renders.
  const session = rows.find((row) => isTaskWorkbenchDeliverSessionName(row.base.conversationName))
  if (session) {
    return {
      state: 'deliver-session',
      ...target,
      action: { kind: 'open-terminal', paneKey: session.base.paneKey }
    }
  }
  if (rows.some((row) => row.base.bucket === 'working')) {
    return {
      state: 'one-writer',
      ...target,
      action: { kind: 'deliver', enabled: false, disabledReason: DISABLED_WORKING }
    }
  }

  const delivery = view.delivery
  if (delivery === undefined) {
    return { state: 'evidence-not-read', ...target, action: DELIVER_ENABLED }
  }
  // Zero commits and no PR is the only shape that reads as "read, and there is
  // nothing yet"; a PR with zero commits, or any commit, is `has-evidence`.
  if (delivery.commits.count === 0 && delivery.pullRequest === undefined) {
    return { state: 'zero-evidence', ...target, action: DELIVER_ENABLED }
  }
  return { state: 'has-evidence', ...target, action: DELIVER_ENABLED }
}
