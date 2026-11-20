import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from 'react'
import { toast } from 'sonner'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { resolveDashboardCardContext } from '@/components/dashboard/dashboard-card-context'
import { dashboardRowBucketProjection } from '@/components/dashboard/dashboard-row-bucket'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { TaskWorkbenchDeliverConfirmValue } from '@/components/task-workbench/task-workbench-deliver-confirm'
import {
  projectTaskWorkbenchDeliver,
  type TaskWorkbenchDeliverProjection
} from '@/components/task-workbench/task-workbench-deliver-state'
import type {
  AgentRowView,
  TaskWorkbenchView
} from '@/components/task-workbench/task-workbench-view'
import { translate } from '@/i18n/i18n'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { useAppStore } from '@/store'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

/**
 * The sidebar workspace row's delivery entry (README §7.11.3 rules 1, 4, 7,
 * §7.11.5): the state the `交付…` item renders, the confirmation it opens, and
 * the one launch path behind its submit.
 *
 * Why the six states are not decided here: `projectTaskWorkbenchDeliver` owns
 * them, and re-deciding any of them (archived? working agent? existing `DELIVER`
 * session?) would give the two entries two opinions about the same workspace.
 * This module translates the sidebar's own rows into the view shape that
 * projection reads, then hands it the id of the row that was right-clicked.
 *
 * Why one module and not four more lines in the menu model: this is exactly what
 * §7.11 needs on this side of the app — projection, three confirm states, one
 * submit — and keeping it together is what lets the menu model stay a layout
 * model. It reads no store slice of its own beyond the row pipeline the sidebar
 * cards already run.
 */

export type WorktreeContextMenuDeliverInput = {
  worktree: Pick<Worktree, 'id' | 'isArchived'>
  /** The workspace's live agent rows — the same per-worktree pipeline the
   *  sidebar cards render (`useWorktreeAgentRows`), never a second derivation. */
  agentRows: readonly DashboardAgentRow[]
  /** The effective status and review the dashboard card context resolves for
   *  this worktree. Both are optional because a folder row has neither; passing
   *  them is what lets a delivered row stop offering a second delivery. */
  workspaceStatusId?: string
  review?: { number: number; state: 'draft' | 'open' | 'merged' | 'closed' }
}

/** The value the menu model holds while the menu is closed: nothing to render.
 *  One module constant, so a closed (common) row allocates nothing and the menu
 *  item simply is not there instead of rendering a disabled ghost. */
export const NO_SIDEBAR_DELIVER_PROJECTION: TaskWorkbenchDeliverProjection = {
  state: 'no-workspace',
  action: { kind: 'none' },
  facts: {},
  attention: []
}

/**
 * Only a name the tab itself owns can be the frozen `DELIVER` marker, so the
 * shared resolver runs with generated titles off: `customTitle` wins, then
 * `quickCommandLabel` (the field the launcher writes), then the tab's own title.
 * The sidebar model reads no `tabAutoGenerateTitle` setting, and a generated
 * title could never be the marker — so passing `false` keeps one resolver
 * instead of forking the precedence into this file.
 */
function tabOwnedConversationName(row: DashboardAgentRow): string | undefined {
  return getAgentRowConversationName(row.tab, row.agentType, false) ?? undefined
}

/**
 * One row, in the shape the projection reads.
 *
 * Why the assertion: `AgentRowView.base` is the published `DashboardCard` the
 * dashboard snapshot builds (thirty-odd fields, several store slices each).
 * `projectTaskWorkbenchDeliver` reads four of them — `worktreeId`, `paneKey`,
 * `bucket` and `conversationName` — so this is the minimum honest card for this
 * one decision, not a second snapshot producer. `tokens` is never read here
 * either; `unattributed` is the existing word for "no per-row figure", and the
 * sidebar reads no usage join at all.
 */
function toAgentRowView(
  worktreeId: string,
  archived: boolean,
  row: DashboardAgentRow
): AgentRowView {
  const base = {
    worktreeId,
    paneKey: row.paneKey,
    // Why the shared projection: `working` here must mean what the card and the
    // board mean, including the decay and display-state rules behind `bucket`.
    bucket: dashboardRowBucketProjection(row).bucket,
    conversationName: tabOwnedConversationName(row)
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: base carries exactly the four DashboardCard fields the projection reads (worktreeId, paneKey, bucket, conversationName) and nothing consumer-local reads any other field of this stand-in card; `AgentRowView.base` is the published snapshot type whose remaining fields require store slices this sidebar row does not have.
    base: base as unknown as DashboardCard,
    tokens: { kind: 'unavailable', reason: 'unattributed' },
    ...(archived ? { archivedWorkspace: true } : {})
  }
}

/**
 * The projection for the clicked row.
 *
 * A row of an archived workspace still reaches the projection (so it can answer
 * `archived` rather than `no-workspace`); its agent rows are marked
 * `archivedWorkspace` for the same reason the workbench marks them — history
 * whatever their live bucket still says (§7.10).
 */
export function projectWorktreeContextMenuDeliver({
  worktree,
  agentRows,
  workspaceStatusId,
  review
}: WorktreeContextMenuDeliverInput): TaskWorkbenchDeliverProjection {
  const archived = worktree.isArchived === true
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an explicit workspace id makes the projection read only `workspaces` (id lookup), `agents` and `delivery`; the remaining TaskWorkbenchView fields (identity, title, spend, defaultWorkspace) belong to the workbench page and are never touched on this path, so inventing values for them here would pretend the sidebar has a workbench view.
  const view = {
    workspaces: [
      {
        worktreeId: worktree.id,
        archived,
        ...(workspaceStatusId !== undefined ? { workspaceStatusId } : {}),
        ...(review !== undefined ? { review } : {})
      }
    ],
    agents: agentRows.map((row) => toAgentRowView(worktree.id, archived, row))
  } as unknown as TaskWorkbenchView
  return projectTaskWorkbenchDeliver(view, worktree.id)
}

/**
 * The delivery launcher, loaded only when a reader actually opens or submits.
 *
 * Why dynamic: `lib/task-workbench/task-workbench-deliver-launch.ts` starts a tab,
 * so it pulls the agent-startup graph (tab launcher, native chat, the localized
 * agent catalog). This hook is mounted on EVERY sidebar row, and an eager import
 * here would put that graph on each row's module path for an action only the
 * confirmation uses. The confirmation itself stays a static import: it is cheap,
 * and the panel must not unmount while the launcher loads.
 */
function loadDeliverLaunch() {
  return import('@/lib/task-workbench/task-workbench-deliver-launch')
}

/** The frozen refusal sentence (§7.11.3 rule 4). The projection emits this
 *  exact pair for `one-writer`; a submit that re-projects into any other
 *  non-launchable state (archived, no workspace) has no sentence of its own in
 *  the frozen vocabulary, and inventing one would add a catalog key. */
const DELIVER_REFUSED_NOTICE = {
  key: 'auto.components.TaskWorkbenchDeliver.disabledWorking',
  fallback: 'A working agent already owns this workspace; delivery waits for one writer.'
}

/** The confirmation panel's own box (440px wide) plus the viewport margin, and
 *  its designed height. Used only to keep the fixed-position panel on screen
 *  next to the right-click point; layout, never state. */
const DELIVER_PANEL_WIDTH = 448
const DELIVER_PANEL_HEIGHT = 380

/**
 * Where the confirmation opens: at the point the reader right-clicked, flipped
 * above it when the panel would otherwise run off the bottom edge.
 *
 * Why fixed positioning: the panel is hosted next to the dropdown, inside the
 * virtualized sidebar list, whose scroll container clips absolute children —
 * the same reason the workbench host places its panel fixed against the entry
 * (`TaskWorkbenchDelivery.tsx`).
 */
function deliverConfirmPlacement(
  scope: HTMLElement | null,
  point: { x: number; y: number }
): CSSProperties | undefined {
  if (!scope) {
    return undefined
  }
  const bounds = scope.getBoundingClientRect()
  const anchorX = bounds.left + point.x
  const anchorY = bounds.top + point.y
  const maxLeft = Math.max(8, window.innerWidth - DELIVER_PANEL_WIDTH)
  const fitsBelow = anchorY + 4 + DELIVER_PANEL_HEIGHT <= window.innerHeight
  return {
    position: 'fixed',
    left: Math.max(8, Math.min(anchorX, maxLeft)),
    top: fitsBelow ? anchorY + 4 : Math.max(8, anchorY - DELIVER_PANEL_HEIGHT - 4)
  }
}

/** The dropdown this row's entry lives in: whether it is open (the item is only
 *  rendered then), where the reader right-clicked (the confirmation opens there),
 *  and the two handles the command needs to close it and measure the row. */
export type WorktreeContextMenuDeliverMenu = {
  menuOpen: boolean
  menuPoint: { x: number; y: number }
  scopeRef: RefObject<HTMLDivElement | null>
  setMenuOpenState: (open: boolean) => void
}

export function useWorktreeContextMenuDeliver(
  worktree: Worktree,
  repo: Repo | null | undefined,
  allWorktrees: readonly Worktree[],
  { menuOpen, menuPoint, scopeRef, setMenuOpenState }: WorktreeContextMenuDeliverMenu
) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmStyle, setConfirmStyle] = useState<CSSProperties | undefined>(undefined)
  const active = menuOpen || confirmOpen
  const agentRows = useWorktreeAgentRows(worktree.id, active)
  // The same dashboard context the cards read, gated on `active` so a closed row
  // subscribes to nothing. Passing the effective status and review is what lets
  // the projection answer `completed` here, not only on the task page.
  const workspaceStatuses = useAppStore((state) => (active ? state.workspaceStatuses : undefined))
  const hostedReviewCache = useAppStore((state) => (active ? state.hostedReviewCache : undefined))
  const prCache = useAppStore((state) => (active ? state.prCache : undefined))
  const settings = useAppStore((state) => (active ? state.settings : undefined))
  const workspaceFacts = useMemo(() => {
    if (!active) {
      return undefined
    }
    const context = resolveDashboardCardContext(
      {
        ...(workspaceStatuses !== undefined ? { workspaceStatuses } : {}),
        ...(hostedReviewCache !== undefined ? { hostedReviewCache } : {}),
        ...(prCache !== undefined ? { prCache } : {}),
        ...(settings !== undefined ? { settings } : {})
      },
      repo ?? null,
      worktree
    )
    return { workspaceStatusId: context.workspaceStatus.id, review: context.review }
  }, [active, hostedReviewCache, prCache, repo, settings, workspaceStatuses, worktree])
  const projection = useMemo(
    () =>
      active
        ? projectWorktreeContextMenuDeliver({
            worktree,
            agentRows,
            workspaceStatusId: workspaceFacts?.workspaceStatusId,
            review: workspaceFacts?.review
          })
        : NO_SIDEBAR_DELIVER_PROJECTION,
    [active, agentRows, workspaceFacts, worktree]
  )
  // Why a ref and not the memo above: submit re-projects from the latest inputs
  // after the launcher's dynamic import settles (K1). The memo is a render-time
  // value; the ref lets the submit read whatever the row list and the dashboard
  // context say by then — a new Working owner, a marker session, an archived
  // workspace, or a completed status/review — instead of the state the
  // confirmation was opened in.
  const latestProjectionInput = useRef<WorktreeContextMenuDeliverInput>({
    worktree,
    agentRows,
    workspaceStatusId: workspaceFacts?.workspaceStatusId,
    review: workspaceFacts?.review
  })
  useEffect(() => {
    latestProjectionInput.current = {
      worktree,
      agentRows,
      workspaceStatusId: workspaceFacts?.workspaceStatusId,
      review: workspaceFacts?.review
    }
  }, [agentRows, worktree, workspaceFacts])
  const heading = useMemo(
    () =>
      [repo?.displayName ?? '', resolveWorktreeDisplayName(worktree)]
        .filter((part) => part.trim() !== '')
        .join(' · '),
    [repo, worktree]
  )
  // Why only while the panel is open: the main worktree's branch is a default for
  // the form, not a fact this row renders. A detached or unscanned checkout has
  // no branch name, and then the field correctly starts empty (submit blocked)
  // instead of guessing `main`.
  const defaultTargetBranch = useMemo(() => {
    if (!confirmOpen) {
      return undefined
    }
    const mainWorktree = allWorktrees.find(
      (candidate) => candidate.repoId === worktree.repoId && candidate.isMainWorktree
    )
    const branch = mainWorktree ? resolveWorktreeBranchLabel(mainWorktree).trim() : ''
    return branch === '' ? undefined : branch
  }, [allWorktrees, confirmOpen, worktree.repoId])

  const openConfirm = useCallback(() => {
    setConfirmStyle(deliverConfirmPlacement(scopeRef.current, menuPoint))
    setSubmitting(false)
    setConfirmOpen(true)
  }, [menuPoint, scopeRef])
  const handleDeliverCancel = useCallback(() => {
    setConfirmOpen(false)
    setSubmitting(false)
  }, [])
  const handleDeliver = useCallback(() => {
    const action = projection.action
    if (action.kind === 'none') {
      return
    }
    if (action.kind === 'deliver' && !action.enabled) {
      // The item is `aria-disabled` and the view prevents activation, so this is
      // the guard that keeps a future caller from opening a confirmation the
      // projection refused.
      return
    }
    setMenuOpenState(false)
    if (action.kind === 'open-terminal' || action.kind === 'open-session') {
      // Rule 4: the entry opens the session that already exists. Nothing is
      // launched from here, so a second click cannot start a second agent.
      const targetId = projection.workspaceId ?? worktree.id
      void loadDeliverLaunch().then(({ revealTaskWorkbenchDeliverTab }) => {
        if (revealTaskWorkbenchDeliverTab(targetId)) {
          return
        }
        // A stale `open-terminal` row still has a delivery ahead of it, so K4
        // falls back to the confirmation. `open-session` belongs to a delivered
        // workspace: its report is the only thing there is to open, and opening
        // a delivery confirmation would offer a second delivery instead.
        if (action.kind === 'open-terminal') {
          openConfirm()
        }
      })
      return
    }
    openConfirm()
  }, [openConfirm, projection, setMenuOpenState, worktree.id])
  const handleDeliverSubmit = useCallback(
    (value: TaskWorkbenchDeliverConfirmValue) => {
      if (submitting) {
        return
      }
      // Why the guard lives until the panel closes: the launch itself is
      // synchronous once the launcher module is loaded, but the panel stays open
      // after `no-agent`, and a second click there must not be able to start a
      // second agent (§7.11.3 rule 4). Setting it before the wait also stops two
      // clicks in one tick from racing.
      setSubmitting(true)
      void loadDeliverLaunch().then(
        ({
          launchTaskWorkbenchDeliver,
          revealTaskWorkbenchDeliverTab,
          TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE
        }) => {
          // Why re-project here (K1): the confirmation is hosted outside the
          // menu and stays open while the row list keeps updating. Opening it
          // proves eligibility only at that moment; a Working owner may have
          // appeared since, or the workspace may have been archived. The
          // launcher re-checks the DELIVER marker, not eligibility, so this is
          // the one place that can still refuse the submit. Existing-session
          // precedence is the projection's, not a local rule: a marker row
          // re-projects to `open-terminal` and is revealed instead.
          const current = projectWorktreeContextMenuDeliver(latestProjectionInput.current)
          const currentAction = current.action
          if (currentAction.kind !== 'deliver' || !currentAction.enabled) {
            if (
              currentAction.kind === 'open-terminal' ||
              currentAction.kind === 'open-session'
            ) {
              revealTaskWorkbenchDeliverTab(current.workspaceId ?? worktree.id)
            } else {
              const notice =
                currentAction.kind === 'deliver'
                  ? currentAction.disabledReason
                  : DELIVER_REFUSED_NOTICE
              // Same frozen sentence the disabled item carries; no new key and
              // no second confirmation copy. Closing the panel is deliberate:
              // the state that allowed it is gone.
              toast.error(translate(notice.key, notice.fallback))
            }
            handleDeliverCancel()
            return
          }
          const result = launchTaskWorkbenchDeliver({
            worktreeId: worktree.id,
            targetBranch: value.targetBranch,
            integrationMode: value.integrationMode,
            mergePullRequest: value.mergePullRequest,
            // The menu is not a page: it carries no item number, so the issue
            // close stays unauthorized here rather than guessing one from the
            // worktree's link (§7.12 A3). The task page is where an issue is
            // named.
            closeIssue: value.closeIssue,
            archiveAfter: value.archiveAfter,
            source: 'sidebar'
          })
          if (result.ok) {
            handleDeliverCancel()
            return
          }
          if (result.reason === 'no-agent') {
            // The panel stays open with its guard still on and the existing
            // terminal copy says why — no new key, no second sentence.
            toast.error(
              translate(
                TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE.key,
                TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE.fallback
              )
            )
            return
          }
          // A session appeared between render and click (the documented reopen
          // case): point at it instead of starting another one.
          revealTaskWorkbenchDeliverTab(worktree.id)
          handleDeliverCancel()
        }
      )
    },
    [handleDeliverCancel, submitting, worktree.id]
  )

  return {
    deliverConfirmHeading: heading,
    deliverConfirmOpen: confirmOpen,
    deliverConfirmStyle: confirmStyle,
    deliverDefaultTargetBranch: defaultTargetBranch,
    deliverProjection: projection,
    deliverSubmitting: submitting,
    handleDeliver,
    handleDeliverCancel,
    handleDeliverSubmit
  }
}
