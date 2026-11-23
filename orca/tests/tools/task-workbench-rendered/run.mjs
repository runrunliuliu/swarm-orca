import { _electron as electron } from '@stablyai/playwright-test'
import { build } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Rendered harness for the task-workbench surfaces (w6-harness): the P1a
 * workbench shell.
 *
 * One fixture and one window size per process: the shared hidden-window host is
 * reused unmodified and its content size is set through the main process, then
 * the page is loaded with `?fixture=`. Every `data-testid` in contract §4.3 is
 * checked by name against an expectation derived from the committed fixture and
 * the pure layout function, so the DOM cannot drift from the data. A failure
 * still writes its report and screenshot (that is the evidence).
 */

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Requires ORCA_BACKGROUND_LAUNCH=1')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = import.meta.dirname
const outputRoot = path.join(root, '.bench-fixtures')
mkdirSync(outputRoot, { recursive: true })

const SCOPE =
  'Production TaskWorkbenchPanel and its seven sections plus the issue #31 run-history strip, rendered with the committed P1a and delivery fixtures (§7.11 testids and §7.12 delivered/archived states), the production delivery confirmation (its deliver scope), the production folder-workspace row with its draft/linked marker, and the production GitHub task rows with the P3 row-activity badge. Proves data-testid presence/counts, the rendered layout decision, degradation copy, the delivery state signature and fact items, the six §7.11 delivery-entry states and their closed-popover semantics, the confirmation scope defaults without a dialog role, history facts/compact/trace-lost claims plus the record-sourced archived rows with their per-row locate and resume actions, the archived fold-row count equal to the facts agent count, the compact strip measured unclipped at 900 and 899 (rect, content width, viewport containment), per-row draft badge/link text, per-row activity kind/label next to an unchanged tracker state, badge geometry inside the viewport, hidden/unfocused windows, no pageerror and CDP screenshots. It does not exercise a live store action, RPC, popover interaction (the confirmation is rendered directly) or locale switching.'

// Contract §4.2 plus the two §7.11 delivery-only fixture rows, copied by hand:
// the fixture data is the other side of this pin, so a fixture edit that changes
// a count fails here instead of silently moving every layout decision with it.
const CONTRACT_COUNTS = {
  f1_baseline: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f2a_zero_workspace_open: { workspaces: 0, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  f2b_zero_workspace_closed: { workspaces: 0, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  f2c_archived_only_closed: { workspaces: 1, agents: 2, activeAgents: 0, attentionAgents: 0, historyAgents: 2 },
  f2d_deleted_with_history: { workspaces: 0, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  f3_many_workspaces_agents: { workspaces: 3, agents: 10, activeAgents: 4, attentionAgents: 1, historyAgents: 5 },
  f4_usage_disabled: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f5_archived_only: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  f6_no_tracker: { workspaces: 1, agents: 1, activeAgents: 1, attentionAgents: 0, historyAgents: 0 },
  f7_remote_workspace: { workspaces: 1, agents: 1, activeAgents: 1, attentionAgents: 0, historyAgents: 0 },
  f8_failure_outcome: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  f9_long_labels: { workspaces: 1, agents: 3, activeAgents: 2, attentionAgents: 0, historyAgents: 1 },
  f10_ambiguous_session: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f11_no_matching_session: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f12_new_workspace_no_agents: { workspaces: 1, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  f13_existing_deliver_session: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  f14_zero_delivery_evidence: { workspaces: 1, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  // §7.12: one completed workspace with a merged PR and one finished DELIVER
  // session, so the delivered row and its two facts are on screen.
  f15_delivered: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  f16_delivered_archived: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 }
}

// The single-run path is the only implementation; --all is a sequential loop
// over it, so the peak stays at one Electron window.
const SHOT_MATRIX = [
  { id: 'S1', fixture: 'f1_baseline', width: 1440, height: 900, mandatory: true },
  { id: 'S2', fixture: 'f1_baseline', width: 1100, height: 800, mandatory: true },
  { id: 'S4', fixture: 'f2a_zero_workspace_open', width: 1440, height: 900, mandatory: true },
  { id: 'S3', fixture: 'f1_baseline', width: 1280, height: 480 },
  { id: 'S5', fixture: 'f2b_zero_workspace_closed', width: 1440, height: 900 },
  // Issue #31: the two "ran before, but is not here now" states. F2c keeps the
  // archived workspace (agent rows in the History fold); F2d has no row left and
  // the strip carries its own run list. The narrow probes pin the compact form at
  // the issue's own `<900` wording and at 900, the width the earlier review used.
  { id: 'F2c', fixture: 'f2c_archived_only_closed', width: 1440, height: 900 },
  { id: 'F2c-narrow', fixture: 'f2c_archived_only_closed', width: 900, height: 700 },
  { id: 'F2c-under-900', fixture: 'f2c_archived_only_closed', width: 899, height: 700 },
  { id: 'F2d', fixture: 'f2d_deleted_with_history', width: 1440, height: 900 },
  { id: 'S6', fixture: 'f3_many_workspaces_agents', width: 1440, height: 900 },
  { id: 'S7', fixture: 'f4_usage_disabled', width: 1440, height: 900 },
  { id: 'S8', fixture: 'f7_remote_workspace', width: 1440, height: 900 },
  { id: 'S9a', fixture: 'f10_ambiguous_session', width: 1440, height: 900 },
  { id: 'S9b', fixture: 'f11_no_matching_session', width: 1440, height: 900 },
  { id: 'S10a', fixture: 'f5_archived_only', width: 1440, height: 900 },
  { id: 'S10b', fixture: 'f6_no_tracker', width: 1440, height: 900 },
  { id: 'S10c', fixture: 'f8_failure_outcome', width: 1440, height: 900 },
  { id: 'S10d', fixture: 'f12_new_workspace_no_agents', width: 1440, height: 900 },
  { id: 'F9', fixture: 'f9_long_labels', width: 1440, height: 900 },
  // README §7.11.3: the other four frozen states reuse S1/S4/S10a/S10d.
  // Only these two states need new fixture data and therefore new matrix rows.
  { id: 'D-existing-session', fixture: 'f13_existing_deliver_session', width: 1440, height: 900 },
  { id: 'D-zero-evidence', fixture: 'f14_zero_delivery_evidence', width: 1440, height: 900 },
  // §7.12: the delivered row, and the same row at a narrow width where the
  // state signature and the fact items must wrap instead of being clipped.
  { id: 'D-delivered', fixture: 'f15_delivered', width: 1440, height: 900 },
  { id: 'D-delivered-narrow', fixture: 'f15_delivered', width: 900, height: 700 },
  // §7.12 D1: the confirmation's deliver scope, rendered directly because the
  // static pass never clicks the entry that opens it.
  { id: 'D-confirm', fixture: 'deliver_confirm', width: 720, height: 660 },
  { id: 'D-delivered-archived', fixture: 'f16_delivered_archived', width: 1440, height: 900 },
  // Issue #27: the wide list row, then the same rows at a narrow window, where
  // §7.2's row priority must keep the mark on screen.
  { id: 'G1', fixture: 'd6_github_task_rows', width: 1440, height: 900, mandatory: true },
  { id: 'G2', fixture: 'd6_github_task_rows', width: 900, height: 700 }
]

// Calibration probes, not part of S1-S10: these exercise the branches the
// numbered sizes cannot reach (900 < 1100, 479 < 480). Kept out of --all so the
// required matrix stays a clean gate; run with --calibrate to reproduce.
const CALIBRATION_MATRIX = [
  { id: 'calibration-single-column', fixture: 'f1_baseline', width: 900, height: 700, extra: true },
  { id: 'calibration-short', fixture: 'f1_baseline', width: 1280, height: 479, extra: true }
]

const DERIVE_SOURCE = `
import { getTaskWorkbenchFixture } from './src/renderer/src/components/task-workbench/task-workbench-fixtures'
import { computeTaskWorkbenchLayout } from './src/renderer/src/components/task-workbench/task-workbench-layout'
import { projectTaskWorkbenchDeliver } from './src/renderer/src/components/task-workbench/task-workbench-deliver-state'
import { countRowBuckets } from './src/renderer/src/components/task-workbench/task-workbench-row-projection'
import { formatTokens } from './src/renderer/src/components/stats/usage-formatters'

const OUTCOME_TEXT = { success: 'Delivered', failure: 'Failed', cancellation: 'Cancelled' }

/** Mirrors USAGE_STATUS_WORD in task-workbench-usage-status.ts: the visible word
 *  of an absent figure. Kept as a literal so a copy edit in the component has to
 *  be a deliberate edit here too. */
const SPEND_STATUS_WORD = {
  disabled: 'Not enabled',
  unpriced: 'Unpriced',
  ambiguous_session: 'Multiple matches',
  no_matching_session: 'No matching session',
  remote_host: 'Remote host',
  unattributed: 'Unattributed'
}

// §7.12 D1. Every expectation is a literal duplicated from the component, so a
// copy or default edit in the panel has to be a deliberate edit here too.
const DELIVER_CONFIRM_FIXTURE = {
  fixture: 'deliver_confirm',
  scope: [
    { id: 'task-workbench-deliver-create-pr', checked: true, disabled: true },
    { id: 'task-workbench-deliver-merge-pr', checked: true, disabled: false },
    { id: 'task-workbench-deliver-close-issue', checked: true, disabled: false },
    { id: 'task-workbench-deliver-archive-after', checked: false, disabled: false }
  ],
  closeIssueLabel: 'Close issue #412',
  scopeLabel: 'Deliver scope'
}

const SIDEBAR_FIXTURE = {
  fixture: 'd5_sidebar_draft_row',
  rows: [
    { id: 'folder:draft-linked', badge: 'draft', link: 'linked to #412' },
    { id: 'folder:draft-unlinked', badge: 'draft', link: null },
    { id: 'folder:plain-folder', badge: null, link: null }
  ]
}

// Issue #27. The titles and the expected marks are duplicated in fixture.tsx on
// purpose: the driver owns the verdict, so a fixture edit that drops a badge
// fails here instead of moving the expectation with it.
const GITHUB_ROWS_FIXTURE = {
  fixture: 'd6_github_task_rows',
  rows: [
    { title: 'Add login auth', activity: 'working', label: 'Working' },
    { title: 'Retry backfill on resume', activity: 'delivered', label: 'Delivered' },
    { title: 'Sparse task workspace rollout', activity: 'workspace', label: 'Workspace' },
    { title: 'Bump docs', activity: 'needs-you', label: 'Needs you' },
    { title: 'Unclaimed issue', activity: null, label: null }
  ]
}

export function derive(fixtureKey, width, height) {
  if (fixtureKey === GITHUB_ROWS_FIXTURE.fixture) {
    return {
      found: true,
      githubRows: GITHUB_ROWS_FIXTURE,
      expectedTestIds: {
        'github-task-rows-fixture-root': 1,
        'github-task-rows-fixture-list': 1
      }
    }
  }
  if (fixtureKey === DELIVER_CONFIRM_FIXTURE.fixture) {
    return {
      found: true,
      deliverConfirm: DELIVER_CONFIRM_FIXTURE,
      expectedTestIds: {
        'deliver-confirm-fixture-root': 1,
        'task-workbench-deliver-confirm': 1,
        'task-workbench-deliver-close': 1,
        'task-workbench-deliver-target-branch': 1,
        'task-workbench-deliver-target-branch-default': 1,
        'task-workbench-deliver-integration': 1,
        'task-workbench-deliver-create-pr': 1,
        'task-workbench-deliver-merge-pr': 1,
        'task-workbench-deliver-close-issue': 1,
        'task-workbench-deliver-archive-after': 1,
        'task-workbench-deliver-submit': 1,
        'task-workbench-deliver-cancel': 1
      }
    }
  }
  if (fixtureKey === SIDEBAR_FIXTURE.fixture) {
    return {
      found: true,
      sidebar: SIDEBAR_FIXTURE,
      expectedTestIds: {
        'sidebar-fixture-root': 1,
        'sidebar-fixture-list': 1,
        'folder-draft-badge': SIDEBAR_FIXTURE.rows.filter((row) => row.badge !== null).length,
        'folder-draft-link': SIDEBAR_FIXTURE.rows.filter((row) => row.link !== null).length
      }
    }
  }
  const fixture = getTaskWorkbenchFixture(fixtureKey)
  if (!fixture) return { found: false }
  const view = fixture.view
  const counts = { workspaces: view.workspaces.length, ...countRowBuckets(view.agents) }
  const layout = computeTaskWorkbenchLayout({
    containerWidth: width,
    containerHeight: height,
    counts,
    mode: 'static'
  })

  const active = view.workspaces.filter((workspace) => workspace.archived !== true)
  const archived = view.workspaces.filter((workspace) => workspace.archived === true)
  const resolvedDefault =
    view.defaultWorkspace.source === 'none'
      ? undefined
      : view.workspaces.find(
          (workspace) => workspace.worktreeId === view.defaultWorkspace.workspaceId
        )
  const defaultIsActive = resolvedDefault !== undefined && resolvedDefault.archived !== true
  const primary =
    resolvedDefault !== undefined && resolvedDefault.archived !== true
      ? resolvedDefault
      : (active[0] ?? null)
  const secondary = active.filter((workspace) => workspace !== primary)
  const collapseSecondary = view.workspaces.length > 2 && secondary.length > 0
  const archivedOpen = active.length === 0 && archived.length > 0
  // README §7.4.2 renders the compact form as the same rows in the same surface,
  // so both branches show workspace rows: full keeps the primary + the rest (or
  // the fold), compact keeps the primary and any archived row it opened.
  const visibleWorkspaceRows = (
    layout.workspaces === 'full'
      ? [primary, ...(collapseSecondary ? [] : secondary), ...(archivedOpen ? archived : [])]
      : [primary, ...(archivedOpen ? archived : [])]
  ).filter((workspace) => workspace != null)
  const visibleCards = visibleWorkspaceRows.length
  const hostChips = visibleWorkspaceRows.filter((workspace) => workspace.hostKind !== 'local').length

  // History rows are unmounted while the group is collapsed, so row counts and
  // row copy are over visible rows, not over every agent in the fixture.
  const historyExpanded = layout.agentHistory === 'expanded'
  const visibleRows = view.agents.filter((row) => {
    const bucket = row.base.bucket
    return bucket === 'working' || bucket === 'attention' || historyExpanded
  })
  const hasWorkspaces = view.workspaces.length > 0
  const history = view.history
  // The strip is the "ran before, but is not here now" face (issue #31): only
  // an archived or deleted record gets one, never a task whose workspace is live.
  const hasHistory = history !== undefined && history.trace !== 'none'
  // The deleted form has no row left, so the panel drops Agents / Workspaces and
  // the strip is the whole record (issue #31).
  const deletedTrace = history?.trace === 'deleted'
  const historyCompact = layout.columns === 'single' || layout.agentHistory === 'collapsed'
  // The compact form starts collapsed; its notes, actions and run list mount only
  // after the Details toggle is used, which this screenshot pass never does.
  const historyDetailsOpen = !historyCompact
  // Since issue #53 the archived form lists only the rows the record supplied
  // (fromRecord): its live rows are already the Agents section. The deleted form
  // lists the recorded list as a whole. Deriving one number for both would flip a
  // run-count assertion independently of what the panel is allowed to print.
  const historyRecordRuns = hasHistory
    ? deletedTrace
      ? history.runs
      : history.runs.filter((run) => run.fromRecord === true)
    : []
  const historyRows = historyDetailsOpen ? historyRecordRuns : []
  const historyRuns = historyRows.length
  // Both actions are per row, never strip-level: resume needs a resumable row, and
  // locate needs a recorded transcript the reader could actually open.
  const historyResumableRuns = historyRows.filter((run) => run.resumable === true).length
  const historyLocateRuns = historyRows.filter(
    (run) =>
      run.transcriptPath !== undefined &&
      !(run.trace !== undefined && run.trace.presence !== 'present')
  ).length
  const spend = view.spend
  const delivery = view.delivery
  const deliverProjection = projectTaskWorkbenchDeliver(view)
  const outcomes = visibleRows.flatMap((row) => (row.outcome ? [row.outcome] : []))
  const successOutcomes = outcomes.filter((outcome) => outcome === 'success').length
  // An unknown token count renders nothing at all (README §7.4.2), so the chip
  // only exists for rows that have a figure. Declared before expectedTestIds:
  // the table below reads it, and a const read before its declaration is a
  // runtime ReferenceError, not a wrong count.
  const tokenRows = visibleRows.filter((row) => row.tokens.kind !== 'unavailable')

  const expectedTestIds = {
    'task-workbench-panel': 1,
    'task-workbench-panel-layout': 1,
    'task-workbench-empty-state': hasWorkspaces || hasHistory ? 0 : 1,
    'task-workbench-history': hasHistory ? 1 : 0,
    'task-workbench-history-facts': hasHistory ? 1 : 0,
    'task-workbench-history-archived-note':
      hasHistory && history.trace === 'archived' && historyDetailsOpen ? 1 : 0,
    'task-workbench-history-trace-lost':
      hasHistory && deletedTrace && historyDetailsOpen ? 1 : 0,
    'task-workbench-history-trace':
      hasHistory && history.trace === 'archived' && historyDetailsOpen ? 1 : 0,
    'task-workbench-history-trace-locate':
      hasHistory && history.trace === 'archived' && historyDetailsOpen ? 1 : 0,
    // The archived list renders only when it has record rows; otherwise the strip
    // states "No run recorded." instead (issue #53 T2, so an empty record never
    // reads as a workspace that ran nothing).
    'task-workbench-history-runs':
      hasHistory && historyDetailsOpen && (deletedTrace || historyRuns > 0) ? 1 : 0,
    'task-workbench-history-runs-none':
      hasHistory && historyDetailsOpen && historyRuns === 0 && !deletedTrace ? 1 : 0,
    'task-workbench-history-run': historyRuns,
    'task-workbench-history-run-resume': historyResumableRuns,
    'task-workbench-history-run-locate': historyLocateRuns,
    'task-workbench-history-details': hasHistory && historyCompact ? 1 : 0,
    'task-workbench-agents': deletedTrace ? 0 : 1,
    'task-workbench-agents-empty': !deletedTrace && counts.agents === 0 ? 1 : 0,
    'task-workbench-agents-active':
      !deletedTrace && counts.activeAgents + counts.attentionAgents > 0 ? 1 : 0,
    'task-workbench-agents-attention':
      !deletedTrace && counts.attentionAgents > 0 ? 1 : 0,
    'task-workbench-agents-history-toggle':
      !deletedTrace && counts.historyAgents > 0 ? 1 : 0,
    'task-workbench-agents-history-count': !deletedTrace && counts.historyAgents > 0 ? 1 : 0,
    'task-workbench-agents-history-empty':
      !deletedTrace && counts.historyAgents === 0 ? 1 : 0,
    'task-workbench-agents-history-records':
      !deletedTrace && historyExpanded && counts.historyAgents > 0 ? 1 : 0,
    'task-workbench-agent-row': deletedTrace ? 0 : visibleRows.length,
    'task-workbench-agent-row-icon': deletedTrace ? 0 : visibleRows.length,
    'task-workbench-agent-row-action': deletedTrace ? 0 : visibleRows.length,
    'task-workbench-agent-row-tokens': deletedTrace ? 0 : tokenRows.length,
    'task-workbench-agent-row-dot': deletedTrace
      ? 0
      : visibleRows.filter(
          ({ outcome, sessionBoundary }) =>
            outcome === 'failure' || outcome === 'cancellation' || sessionBoundary === true
        ).length,
    'task-workbench-agent-row-outcome': deletedTrace ? 0 : outcomes.length,
    'task-workbench-agent-row-workspace-pill':
      !deletedTrace && view.workspaces.length > 1
        ? visibleRows.filter((row) => row.workspaceLabel !== undefined).length
        : 0,
    'task-workbench-workspaces': !deletedTrace && hasWorkspaces ? 1 : 0,
    'task-workbench-workspace-card': deletedTrace ? 0 : visibleCards,
    'task-workbench-workspace-host-chip': deletedTrace ? 0 : hostChips,
    'task-workbench-workspace-card-default': !deletedTrace && defaultIsActive ? 1 : 0,
    'task-workbench-workspaces-create': deletedTrace ? 0 : 1,
    // Mirrors the component: >2 workspaces with a leftover row *and* the full
    // layout. The compact branch prints "+N more" text instead of this toggle.
    'task-workbench-workspaces-secondary-toggle':
      !deletedTrace && layout.workspaces === 'full' && collapseSecondary ? 1 : 0,
    'task-workbench-workspaces-archived-toggle':
      !deletedTrace && archived.length > 0 ? 1 : 0,
    'task-workbench-facts': 1,
    'task-workbench-spend': 1,
    'task-workbench-spend-total': spend.kind === 'available' ? 1 : 0,
    'task-workbench-spend-status': spend.kind === 'unavailable' ? 1 : 0,
    'task-workbench-spend-unattributed':
      spend.kind === 'available' && spend.unattributedSessions > 0 ? 1 : 0,
    // Provider detail is Spend detail: layout 'summary' is one line by design
    // (contract §4.1), so the rows exist only in the full form.
    'task-workbench-spend-provider-row':
      spend.kind === 'available' && layout.spend === 'full' ? spend.byProvider.length : 0,
    'task-workbench-spend-cta':
      spend.kind === 'unavailable' && spend.reason === 'disabled' ? 1 : 0,
    'task-workbench-delivery': 1,
    // The "not read yet" row owns the Load evidence action; with evidence the row
    // offers the fold instead (README §7.4.3).
    'task-workbench-delivery-read': delivery === undefined ? 1 : 0,
    'task-workbench-delivery-toggle': delivery !== undefined ? 1 : 0,
    'task-workbench-delivery-body':
      delivery !== undefined && layout.delivery === 'expanded' ? 1 : 0,
    'task-workbench-delivery-commits':
      delivery !== undefined && (delivery.commits?.count ?? 0) > 0 ? 1 : 0,
    'task-workbench-delivery-checks': delivery && delivery.checks ? 1 : 0,
    'task-workbench-delivery-review': delivery && delivery.review ? 1 : 0,
    // §7.12: the state signature and the fact items are rendered from the same
    // projection the tests read. The no-workspace state states nothing, so
    // neither element exists; the facts line suppresses a PR only when the
    // evidence strip prints that same PR (same number). The strip's evidence is
    // task-level and may name another workspace, so existence alone is not
    // identity.
    'task-workbench-delivery-state': deliverProjection.state === 'no-workspace' ? 0 : 1,
    'task-workbench-delivery-facts':
      (deliverProjection.facts.pullRequest !== undefined &&
        delivery?.pullRequest?.number !== deliverProjection.facts.pullRequest.number) ||
      deliverProjection.facts.issue !== undefined
        ? 1
        : 0,
    // The delivery entry is derived from the fixture through the production
    // projection, never copied from a list of fixture names. The rendered pass
    // does not click, so the shared confirmation must stay closed.
    'task-workbench-deliver-action': deliverProjection.action.kind === 'none' ? 0 : 1,
    'task-workbench-deliver-confirm': 0
  }

  // README §7.12 §6.2: the state word is the projection's own state, never a
  // second vocabulary. Kept as literals so a copy edit in the component has to
  // be a deliberate edit here too.
  const DELIVER_STATE_WORD = {
    'no-workspace': null,
    archived: 'Archived',
    completed: 'Delivered',
    'deliver-session': 'Delivering',
    'one-writer': 'Ready',
    'zero-evidence': 'Ready',
    'has-evidence': 'Ready',
    'evidence-not-read': 'Not loaded'
  }

  const semantic = {
    tokenChips: tokenRows.map((row) => formatTokens(row.tokens.tokens)).sort(),
    outcomeBadges: outcomes.map((outcome) => OUTCOME_TEXT[outcome]).sort(),
    // README §7.4.2 prints the reader's word; the internal token
    // ('unavailable · disabled') is only the tag's tooltip.
    spendStatusWord:
      spend.kind === 'unavailable' ? SPEND_STATUS_WORD[spend.reason] : null,
    spendTotal:
      spend.kind === 'available'
        ? {
            tokens: formatTokens(spend.tokens) + ' tokens',
            cost: spend.costUsd === null ? '—' : 'est. $' + spend.costUsd.toFixed(2)
          }
        : null,
    // README §7.12 D4: since the delivered row exists, the word "Delivered" has
    // two legitimate sources — a success outcome badge, or the projection's
    // completed state. Anything else printing it is still a false claim.
    deliveredExpected: successOutcomes > 0 || deliverProjection.state === 'completed',
    // Both branches render every archived row once the fold is open, so this is
    // the archived count, not "the full layout only".
    archivedVisibleCards: archivedOpen ? archived.length : 0,
    // Issue #31: the strip must state all three fact fields, say when the trace
    // is out of reach, and compress on a narrow window instead of clipping.
    history: hasHistory
      ? {
          fields: ['agents', 'wall', 'tokens'],
          agents: history.agents,
          traceLost: deletedTrace && historyDetailsOpen,
          archivedNote: history.trace === 'archived' && historyDetailsOpen,
          runs: historyRuns,
          compact: historyCompact
        }
      : null,
    deliver: {
      state: deliverProjection.state,
      stateWord: DELIVER_STATE_WORD[deliverProjection.state],
      action: deliverProjection.action,
      // The facts line prints the PR only when the evidence strip does not, and
      // the issue only when the view names one. The expected text is built the
      // same way, so a missing source cannot silently become a claim.
      factsText: (() => {
        const parts = []
        if (delivery?.pullRequest === undefined && deliverProjection.facts.pullRequest) {
          parts.push('PR #' + deliverProjection.facts.pullRequest.number)
          parts.push(deliverProjection.facts.pullRequest.state)
        }
        if (deliverProjection.facts.issue) {
          parts.push(
            'Issue #' +
              deliverProjection.facts.issue.number +
              ' ' +
              deliverProjection.facts.issue.state
          )
        }
        return parts.length === 0 ? null : parts.join(' · ')
      })()
    }
  }

  return {
    found: true,
    label: fixture.label,
    summary: fixture.summary,
    counts,
    layout,
    expectedTestIds,
    semantic
  }
}
`

function parseArgs(argv) {
  const options = { all: false, calibrate: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--all':
        options.all = true
        break
      case '--calibrate':
        options.calibrate = true
        break
      case '--fixture':
        options.fixture = argv[(index += 1)]
        break
      case '--width':
        options.width = Number(argv[(index += 1)])
        break
      case '--height':
        options.height = Number(argv[(index += 1)])
        break
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (options.help || options.all) {
    return options
  }
  if (!options.fixture) {
    throw new Error('--fixture <key> is required (or --all)')
  }
  if (!/^[a-z0-9_]+$/.test(options.fixture)) {
    throw new Error(`Fixture keys are lowercase snake_case: ${options.fixture}`)
  }
  if (!Number.isInteger(options.width) || options.width <= 0) {
    throw new Error('--width must be a positive integer')
  }
  if (!Number.isInteger(options.height) || options.height <= 0) {
    throw new Error('--height must be a positive integer')
  }
  return options
}

const SPARSE_ASSET_PREFIX = '\0sparse-resource:'
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

/** The sparse task checkout omits `orca/resources`, and `agent-catalog.tsx`
 *  imports the OpenClaude logo from it. No fixture renders that icon, so the
 *  harness build resolves the import to a transparent pixel instead of editing
 *  a component or adding the missing tree. */
function sparseResources() {
  return {
    name: 'task-workbench-sparse-resources',
    enforce: 'pre',
    resolveId(id) {
      if (/\/resources\/[^/]+\.(?:png|jpe?g|svg|webp|gif)(?:\?.*)?$/.test(id)) {
        return SPARSE_ASSET_PREFIX + id
      }
      return null
    },
    load(id) {
      if (id.startsWith(SPARSE_ASSET_PREFIX)) {
        return `export default ${JSON.stringify(TRANSPARENT_PNG)}`
      }
      return null
    }
  }
}

async function prepareBuilds() {
  const output = mkdtempSync(path.join(outputRoot, 'task-workbench-build-'))
  const main = path.join(output, 'main.cjs')
  await build({
    entryPoints: [path.join(root, 'tests/tools/benchmarks/spinner-rendering/main.ts')],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  await buildRenderer({
    configFile: false,
    root: fixtureDir,
    base: './',
    logLevel: 'silent',
    plugins: [react(), tailwindcss(), sparseResources()],
    resolve: { alias: { '@': path.join(root, 'src/renderer/src') } },
    build: { outDir: path.join(output, 'renderer'), emptyOutDir: true }
  })
  const deriveOutput = path.join(output, 'derive.mjs')
  await build({
    stdin: {
      contents: DERIVE_SOURCE,
      resolveDir: root,
      sourcefile: 'task-workbench-derive.js',
      loader: 'js'
    },
    outfile: deriveOutput,
    bundle: true,
    platform: 'node',
    format: 'esm'
  })
  const { derive } = await import(pathToFileURL(deriveOutput).href)
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  return { main, renderer: path.join(output, 'renderer'), derive, env }
}

function readPngSize(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Screenshot is not a PNG')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function compare(failures, name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push({ name, expected, actual })
  }
}

/**
 * Issue #31's acceptance says the compact history strip is not clipped. A DOM
 * text assertion cannot tell "the badge is on screen" from "the badge exists",
 * so each visible box is measured twice: `scrollWidth` against its own content
 * width (a squeezed or ellipsised badge stops fitting) and its rect against the
 * viewport and the strip (an overflowing item leaves both).
 */
function assertHistoryGeometry(failures, history, viewport) {
  const insideViewport = (box) =>
    box.left >= -0.5 &&
    box.right <= viewport.width + 0.5 &&
    box.top >= -0.5 &&
    box.bottom <= viewport.height + 0.5
  const assertBox = (name, box, container) => {
    if (box === null) {
      failures.push({ name, expected: 'a rendered box', actual: null })
      return
    }
    compare(failures, `${name}:visible`, box.width > 0 && box.height > 0, true)
    // One pixel of integer rounding is allowed; more than that is content the
    // reader cannot see without scrolling, which this strip never offers.
    compare(failures, `${name}:content-fits`, box.scrollWidth <= box.clientWidth + 1, true)
    compare(failures, `${name}:in-viewport`, insideViewport(box), true)
    if (container !== undefined) {
      compare(
        failures,
        `${name}:inside-container`,
        box.left >= container.left - 0.5 && box.right <= container.right + 0.5,
        true
      )
    }
  }
  assertBox('history:section', history.section)
  assertBox('history:header', history.header, history.section)
  history.headerItems.forEach((item, index) => {
    assertBox(`history:header-item-${index}`, item, history.section)
  })
  assertBox('history:facts', history.factsBox, history.section)
  history.factsItems.forEach((item, index) => {
    assertBox(`history:facts-item-${index}`, item, history.section)
  })
  // Named, so a header that lost the NEW badge cannot pass by being smaller.
  compare(failures, 'history:new-badge', history.headerItems.at(0)?.text ?? null, 'NEW')
  if (history.compact) {
    compare(
      failures,
      'history:details-toggle',
      history.headerItems.at(-1)?.text ?? null,
      'Details'
    )
  }
}

/**
 * The GitHub task rows, located by their title so a row without a badge is still
 * found: a missing mark must be reported as `activity: null`, not as a row that
 * silently disappeared from the list.
 */
async function collectGithubRows(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const rows = []
    for (const heading of document.querySelectorAll('h3')) {
      const row = heading.closest('[role="button"]')
      if (!row) {
        continue
      }
      const badge = row.querySelector('[data-row-activity]')
      const pill = row.querySelector('[class*="group/status"]')
      const rect = badge?.getBoundingClientRect() ?? null
      rows.push({
        title: text(heading),
        activity: badge?.getAttribute('data-row-activity') ?? null,
        badgeText: badge ? text(badge) : null,
        pillText: text(pill),
        badgeRect: rect ? { left: rect.left, right: rect.right, width: rect.width } : null
      })
    }
    return rows
  })
}

/** The confirmation panel's own controls (README §7.12 D1). Located by testid
 *  and by the label ids the component owns, never by row order. */
async function collectDeliverConfirm(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const panel = document.querySelector('[data-testid="task-workbench-deliver-confirm"]')
    const scope = ['create-pr', 'merge-pr', 'close-issue', 'archive-after'].map((key) => {
      const input = document.querySelector(`[data-testid="task-workbench-deliver-${key}"]`)
      return {
        id: `task-workbench-deliver-${key}`,
        checked: input?.getAttribute('data-state') === 'checked',
        disabled:
          input !== null &&
          (input.hasAttribute('disabled') || input.getAttribute('data-disabled') !== null)
      }
    })
    const submit = document.querySelector('[data-testid="task-workbench-deliver-submit"]')
    return {
      exists: panel !== null,
      dialogRoles: document.querySelectorAll('[role="dialog"]').length,
      ariaModal: document.querySelectorAll('[aria-modal="true"]').length,
      submitVariant: submit?.getAttribute('data-variant') ?? null,
      submitText: text(submit),
      submitDisabled: submit?.hasAttribute('disabled') ?? false,
      scope,
      closeIssueLabel: text(
        document.getElementById('task-workbench-deliver-close-issue-label')
      ),
      scopeLabelPresent: (panel?.textContent ?? '').includes('Deliver scope')
    }
  })
}

async function collectDom(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const texts = (selector) => [...document.querySelectorAll(selector)].map((element) => text(element))
    const testIds = {}
    for (const element of document.querySelectorAll('[data-testid]')) {
      const id = element.getAttribute('data-testid')
      testIds[id] = (testIds[id] ?? 0) + 1
    }
    const layoutElement = document.querySelector('[data-testid="task-workbench-panel-layout"]')
    const layoutJson = layoutElement?.getAttribute('data-wb-layout-json')
    return {
      testIds,
      layout: layoutElement
        ? {
            columns: layoutElement.getAttribute('data-wb-columns'),
            json: layoutJson === null || layoutJson === undefined ? null : JSON.parse(layoutJson)
          }
        : null,
      tokenChips: texts('[data-testid="task-workbench-agent-row-tokens"]'),
      agentRowDotStates: [...document.querySelectorAll('[data-testid="task-workbench-agent-row-dot"]')]
        .map((element) => element.getAttribute('data-dot-state')),
      outcomeBadges: texts('[data-testid="task-workbench-agent-row-outcome"]'),
      spendStatus: text(document.querySelector('[data-testid="task-workbench-spend-status"]')),
      spendTotal: text(document.querySelector('[data-testid="task-workbench-spend-total"]')),
      archivedCards: document.querySelectorAll(
        '[data-testid="task-workbench-workspace-card"][data-archived="true"]'
      ).length,
      deliverEntry: (() => {
        const row = document.querySelector('[data-testid="task-workbench-delivery"]')
        const action = document.querySelector('[data-testid="task-workbench-deliver-action"]')
        const describedBy = action?.getAttribute('aria-describedby') ?? null
        const described = describedBy === null ? null : document.getElementById(describedBy)
        return {
          rowText: text(row),
          state:
            document
              .querySelector('[data-testid="task-workbench-delivery-state"]')
              ?.getAttribute('data-state') ?? null,
          stateText: text(document.querySelector('[data-testid="task-workbench-delivery-state"]')),
          factsText: text(document.querySelector('[data-testid="task-workbench-delivery-facts"]')) || null,
          claims: {
            commits: texts('[data-testid="task-workbench-delivery-commits"]'),
            pullRequests: [
              ...(row?.querySelectorAll('span') ?? [])
            ].map((element) => text(element)).filter((value) => /^PR #\d+$/.test(value)),
            checks: texts('[data-testid="task-workbench-delivery-checks"]'),
            reviews: texts('[data-testid="task-workbench-delivery-review"]')
          },
          confirmCount: document.querySelectorAll(
            '[data-testid="task-workbench-deliver-confirm"]'
          ).length,
          action:
            action === null
              ? null
              : {
                  label: text(action),
                  disabled: action.hasAttribute('disabled'),
                  ariaDisabled: action.getAttribute('aria-disabled'),
                  ariaDescribedBy: describedBy,
                  describedText: text(described),
                  describedSrOnly: described?.classList.contains('sr-only') ?? false,
                  wrapperTitle: action.closest('[title]')?.getAttribute('title') ?? null
                }
        }
      })(),
      history: (() => {
        const node = document.querySelector('[data-testid="task-workbench-history"]')
        if (!node) {
          return null
        }
        // Geometry, not presence: issue #31's acceptance says the compact strip
        // is not clipped, and a squeezed badge keeps its text either way.
        const box = (element) => {
          if (!element) {
            return null
          }
          const rect = element.getBoundingClientRect()
          return {
            text: text(element),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth
          }
        }
        const factsNode = document.querySelector('[data-testid="task-workbench-history-facts"]')
        const header = node.firstElementChild
        return {
          facts: text(factsNode),
          compact: node.getAttribute('data-compact') === 'true',
          traceLost: text(document.querySelector('[data-testid="task-workbench-history-trace-lost"]')),
          runs: document.querySelectorAll('[data-testid="task-workbench-history-run"]').length,
          // Counted from the fold, not reused from the view that produced both
          // numbers, so "fold rows == facts agents" can actually disagree.
          archivedFoldRows: document.querySelectorAll(
            '[data-testid="task-workbench-agents-history-records"] [data-testid="task-workbench-agent-row"]'
          ).length,
          section: box(node),
          header: box(header),
          headerItems: header ? [...header.children].map(box) : [],
          factsBox: box(factsNode),
          factsItems: factsNode ? [...factsNode.children].map(box) : []
        }
      })(),
      bodyText: document.body.innerText,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      }
    }
  })
}

async function runOne(entry, builds) {
  const startedAt = Date.now()
  const report = {
    run: entry.id ?? null,
    fixture: entry.fixture,
    requested: { width: entry.width, height: entry.height },
    extraCalibration: entry.extra === true,
    mandatory: entry.mandatory === true,
    scope: SCOPE
  }
  const failures = []
  const pageErrors = []
  const consoleErrors = []
  let app
  try {
    const expectation = builds.derive(entry.fixture, entry.width, entry.height)
    report.expected = expectation.sidebar
      ? { sidebar: expectation.sidebar }
      : expectation.githubRows
        ? { githubRows: expectation.githubRows }
        : expectation.found
          ? { label: expectation.label, summary: expectation.summary, counts: expectation.counts, layout: expectation.layout, semantic: expectation.semantic }
          : { found: false }
    const contractCounts = CONTRACT_COUNTS[entry.fixture]
    if (
      expectation.found &&
      !expectation.sidebar &&
      !expectation.githubRows &&
      !expectation.deliverConfirm &&
      !contractCounts
    ) {
      failures.push({ name: 'counts:missing-contract-row', expected: 'a §4.2 row', actual: entry.fixture })
    }
    if (
      expectation.found &&
      !expectation.sidebar &&
      !expectation.githubRows &&
      !expectation.deliverConfirm &&
      contractCounts
    ) {
      compare(failures, 'counts:contract', expectation.counts, contractCounts)
      compare(
        failures,
        'counts:sum',
        expectation.counts.activeAgents + expectation.counts.attentionAgents + expectation.counts.historyAgents,
        expectation.counts.agents
      )
    }

    app = await electron.launch({ args: [builds.main], env: { ...builds.env, ORCA_BACKGROUND_LAUNCH: '1' } })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
      console.error(error)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })
    await app.evaluate(({ BrowserWindow }, size) => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length !== 1) {
        throw new Error(`Expected one window, found ${windows.length}`)
      }
      windows[0].setContentSize(size.width, size.height)
    }, { width: entry.width, height: entry.height })
    const url = `${pathToFileURL(path.join(builds.renderer, 'index.html')).href}?fixture=${encodeURIComponent(entry.fixture)}`
    await page.goto(url)
    await page.waitForSelector(
      '[data-testid="task-workbench-panel"], [data-testid="task-workbench-fixture-error"], [data-testid="sidebar-fixture-root"], [data-testid="github-task-rows-fixture-root"], [data-testid="deliver-confirm-fixture-root"]',
      { timeout: 30000 }
    )
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) => {
          setTimeout(resolve, 2000)
        })
      ])
    )
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {}))
      )
    })

    const dom = await collectDom(page)
    report.viewport = dom.viewport
    report.counts = expectation.found ? expectation.counts : null
    report.layout = { expected: expectation.found ? expectation.layout : null, actual: dom.layout }
    report.testIds = { expected: expectation.found ? expectation.expectedTestIds : null, actual: dom.testIds }
    report.semantic = {
      expected: expectation.found ? expectation.semantic : null,
      actual: {
        tokenChips: dom.tokenChips,
        agentRowDotStates: dom.agentRowDotStates,
        outcomeBadges: dom.outcomeBadges,
        deliveredText: dom.bodyText.includes('Delivered'),
        spendStatus: dom.spendStatus,
        spendTotal: dom.spendTotal,
        archivedCards: dom.archivedCards,
        deliver: dom.deliverEntry,
        historyFacts: dom.history?.facts ?? null,
        historyCompact: dom.history?.compact ?? null,
        historyTraceLost: dom.history?.traceLost ?? null,
        historyRuns: dom.history?.runs ?? null,
        historyFoldRows: dom.history?.archivedFoldRows ?? null,
        historyGeometry: dom.history
          ? {
              section: dom.history.section,
              facts: dom.history.factsBox,
              headerItems: dom.history.headerItems.length,
              factsItems: dom.history.factsItems.length
            }
          : null
      }
    }

    compare(
      failures,
      'viewport:size',
      { width: dom.viewport.width, height: dom.viewport.height },
      { width: entry.width, height: entry.height }
    )

    if (expectation.sidebar) {
      for (const [id, expectedCount] of Object.entries(expectation.expectedTestIds)) {
        const actualCount = dom.testIds[id] ?? 0
        if (actualCount !== expectedCount) {
          failures.push({ name: `testid:${id}`, expected: expectedCount, actual: actualCount })
        }
      }
      for (const [id, actualCount] of Object.entries(dom.testIds)) {
        if (!(id in expectation.expectedTestIds)) {
          failures.push({ name: `testid:${id}:unexpected`, expected: 0, actual: actualCount })
        }
      }
      if (expectation.sidebar) {
        await assertSidebar(failures, page, report, expectation.sidebar)
      }
    } else if (expectation.githubRows) {
      for (const [id, expectedCount] of Object.entries(expectation.expectedTestIds)) {
        const actualCount = dom.testIds[id] ?? 0
        if (actualCount !== expectedCount) {
          failures.push({ name: `testid:${id}`, expected: expectedCount, actual: actualCount })
        }
      }
      for (const [id, actualCount] of Object.entries(dom.testIds)) {
        if (!(id in expectation.expectedTestIds)) {
          failures.push({ name: `testid:${id}:unexpected`, expected: 0, actual: actualCount })
        }
      }
      const rows = await collectGithubRows(page)
      report.githubRows = rows
      compare(failures, 'github-rows:count', rows.length, expectation.githubRows.rows.length)
      const byTitle = new Map(rows.map((row) => [row.title, row]))
      for (const expectedRow of expectation.githubRows.rows) {
        const actualRow = byTitle.get(expectedRow.title) ?? null
        if (actualRow === null) {
          failures.push({
            name: `github-row:${expectedRow.title}:missing`,
            expected: 'a rendered row',
            actual: null
          })
          continue
        }
        // The badge is additive: the tracker pill keeps reporting the provider's
        // own state on the same row, whatever the Orca mark says.
        compare(failures, `github-row:${expectedRow.title}:tracker-state`, actualRow.pillText, 'Open')
        compare(failures, `github-row:${expectedRow.title}:activity`, actualRow.activity, expectedRow.activity)
        compare(failures, `github-row:${expectedRow.title}:label`, actualRow.badgeText, expectedRow.label)
        if (expectedRow.activity === null) {
          continue
        }
        // Why the geometry: §7.2's row priority says the mark survives the
        // narrow window. A zero-width or off-screen pill is a badge that was
        // squeezed out, which a text assertion alone would not catch.
        const rect = actualRow.badgeRect
        compare(failures, `github-row:${expectedRow.title}:badge-width`, rect !== null && rect.width > 0, true)
        compare(
          failures,
          `github-row:${expectedRow.title}:badge-in-viewport`,
          rect !== null && rect.left >= 0 && rect.right <= dom.viewport.width,
          true
        )
      }
    } else if (expectation.deliverConfirm) {
      for (const [id, expectedCount] of Object.entries(expectation.expectedTestIds)) {
        const actualCount = dom.testIds[id] ?? 0
        if (actualCount !== expectedCount) {
          failures.push({ name: `testid:${id}`, expected: expectedCount, actual: actualCount })
        }
      }
      for (const [id, actualCount] of Object.entries(dom.testIds)) {
        if (!(id in expectation.expectedTestIds)) {
          failures.push({ name: `testid:${id}:unexpected`, expected: 0, actual: actualCount })
        }
      }
      const confirm = await collectDeliverConfirm(page)
      report.deliverConfirm = confirm
      const expectedConfirm = expectation.deliverConfirm
      compare(failures, 'confirm:exists', confirm.exists, true)
      // §7.11.3 rule 2 survives §7.12: the panel is an inline popover with an
      // outline submit, never a modal with a second filled primary.
      compare(failures, 'confirm:no-dialog-role', confirm.dialogRoles, 0)
      compare(failures, 'confirm:no-aria-modal', confirm.ariaModal, 0)
      compare(failures, 'confirm:submit-variant', confirm.submitVariant, 'outline')
      compare(failures, 'confirm:submit-disabled', confirm.submitDisabled, false)
      compare(failures, 'confirm:submit-label', confirm.submitText, 'Start delivery')
      compare(failures, 'confirm:scope-label', confirm.scopeLabelPresent, true)
      compare(failures, 'confirm:close-issue-label', confirm.closeIssueLabel, expectedConfirm.closeIssueLabel)
      for (const expectedScope of expectedConfirm.scope) {
        const actualScope = confirm.scope.find((scope) => scope.id === expectedScope.id)
        if (actualScope === undefined) {
          failures.push({
            name: `confirm:${expectedScope.id}:missing`,
            expected: 'a rendered control',
            actual: null
          })
          continue
        }
        compare(
          failures,
          `confirm:${expectedScope.id}:checked`,
          actualScope.checked,
          expectedScope.checked
        )
        compare(
          failures,
          `confirm:${expectedScope.id}:disabled`,
          actualScope.disabled,
          expectedScope.disabled
        )
      }
    } else if (expectation.found) {
      compare(failures, 'panel:layout-columns', dom.layout?.columns ?? null, expectation.layout.columns)
      compare(failures, 'panel:layout-json', dom.layout?.json ?? null, expectation.layout)
      for (const [id, expectedCount] of Object.entries(expectation.expectedTestIds)) {
        const actualCount = dom.testIds[id] ?? 0
        if (actualCount !== expectedCount) {
          failures.push({ name: `testid:${id}`, expected: expectedCount, actual: actualCount })
        }
      }
      for (const [id, actualCount] of Object.entries(dom.testIds)) {
        if (!(id in expectation.expectedTestIds)) {
          failures.push({ name: `testid:${id}:unexpected`, expected: 0, actual: actualCount })
        }
      }
      const semantic = expectation.semantic
      const expectedDeliver = semantic.deliver
      const actualDeliver = dom.deliverEntry
      compare(failures, 'deliver:confirm-closed', actualDeliver.confirmCount, 0)
      compare(
        failures,
        `deliver:${expectedDeliver.state}:state-attr`,
        actualDeliver.state,
        expectedDeliver.state === 'no-workspace' ? null : expectedDeliver.state
      )
      compare(
        failures,
        `deliver:${expectedDeliver.state}:state-word`,
        actualDeliver.stateText,
        expectedDeliver.stateWord ?? ''
      )
      compare(
        failures,
        `deliver:${expectedDeliver.state}:facts`,
        actualDeliver.factsText,
        expectedDeliver.factsText
      )
      if (expectedDeliver.action.kind === 'none') {
        compare(failures, `deliver:${expectedDeliver.state}:action-absent`, actualDeliver.action, null)
      } else {
        compare(
          failures,
          `deliver:${expectedDeliver.state}:action-present`,
          actualDeliver.action !== null,
          true
        )
      }
      if (expectedDeliver.state === 'one-writer' && expectedDeliver.action.kind === 'deliver') {
        const reason = expectedDeliver.action.disabledReason.fallback
        compare(failures, 'deliver:one-writer:disabled', actualDeliver.action?.disabled, true)
        compare(failures, 'deliver:one-writer:aria-disabled', actualDeliver.action?.ariaDisabled, 'true')
        compare(
          failures,
          'deliver:one-writer:aria-describedby',
          (actualDeliver.action?.ariaDescribedBy ?? '') !== '',
          true
        )
        compare(failures, 'deliver:one-writer:title', actualDeliver.action?.wrapperTitle, reason)
        compare(failures, 'deliver:one-writer:reason', actualDeliver.action?.describedText, reason)
        compare(failures, 'deliver:one-writer:reason-sr-only', actualDeliver.action?.describedSrOnly, true)
      } else if (
        expectedDeliver.state === 'deliver-session' &&
        expectedDeliver.action.kind === 'open-terminal'
      ) {
        compare(failures, 'deliver:existing-session:enabled', actualDeliver.action?.disabled, false)
        compare(failures, 'deliver:existing-session:label', actualDeliver.action?.label, 'Open terminal')
      } else if (expectedDeliver.action.kind === 'deliver') {
        compare(
          failures,
          `deliver:${expectedDeliver.state}:disabled`,
          actualDeliver.action?.disabled,
          !expectedDeliver.action.enabled
        )
        compare(failures, `deliver:${expectedDeliver.state}:label`, actualDeliver.action?.label, 'Deliver…')
      }
      if (expectedDeliver.state === 'zero-evidence') {
        compare(
          failures,
          'deliver:zero-evidence:claims',
          actualDeliver.claims,
          { commits: [], pullRequests: [], checks: [], reviews: [] }
        )
        compare(
          failures,
          'deliver:zero-evidence:no-zero-commit-copy',
          /\b0\s+commits?\b/i.test(actualDeliver.rowText),
          false
        )
      }
      compare(failures, 'semantic:token-chips', [...dom.tokenChips].sort(), semantic.tokenChips)
      compare(failures, 'semantic:outcome-badges', [...dom.outcomeBadges].sort(), semantic.outcomeBadges)
      if (entry.fixture === 'f8_failure_outcome') {
        compare(failures, 'semantic:f8-dot-states', dom.agentRowDotStates, ['failed'])
        compare(failures, 'semantic:f8-outcome-badges', dom.outcomeBadges, ['Failed'])
        compare(failures, 'semantic:f8-delivered-text', dom.bodyText.includes('Delivered'), false)
      }
      const statusText = dom.spendStatus === '' ? null : dom.spendStatus
      compare(failures, 'semantic:spend-status-word', statusText, semantic.spendStatusWord)
      if (semantic.spendTotal) {
        compare(failures, 'semantic:spend-total-tokens', dom.spendTotal.includes(semantic.spendTotal.tokens), true)
        compare(failures, 'semantic:spend-total-cost', dom.spendTotal.includes(semantic.spendTotal.cost), true)
      }
      compare(failures, 'semantic:archived-cards', dom.archivedCards, semantic.archivedVisibleCards)
      compare(failures, 'semantic:no-fake-zero', /\$0(?:\.00)?(?![\d.])/.test(dom.bodyText), false)
      // Issue #31 acceptance: the strip states all three fields, never a "0
      // tokens" placeholder, and the deleted form says the trace is gone.
      if (semantic.history) {
        for (const field of semantic.history.fields) {
          compare(
            failures,
            `history:fact-${field}`,
            (dom.history?.facts ?? '').toLowerCase().includes(field),
            true
          )
        }
        if (semantic.history.agents !== null) {
          // The fold lists exactly the rows the facts line counts, so the strip
          // and the agents section cannot tell two stories. Parsed from the
          // rendered sentence, so a facts line printing a different number than
          // the fold renders is a failure even when both sides derive from the
          // same view.
          const factsAgents = /(-?\d+)\s+agents/.exec(dom.history?.facts ?? '')
          const factsAgentCount = factsAgents === null ? null : Number(factsAgents[1])
          compare(failures, 'history:facts-agents-number', factsAgentCount, semantic.history.agents)
          // Equality, not "contains": issue #31 asks the archived fold's agent
          // row count to equal the facts agent count. Only when the fold is
          // mounted (its own render condition), since a collapsed fold prints no
          // rows by design.
          if (expectation.expectedTestIds['task-workbench-agents-history-records'] === 1) {
            compare(
              failures,
              'history:fold-rows-equal-facts-agents',
              dom.history?.archivedFoldRows ?? null,
              factsAgentCount
            )
          }
        }
        assertHistoryGeometry(failures, dom.history, dom.viewport)
        compare(failures, 'history:compact', dom.history?.compact ?? null, semantic.history.compact)
        compare(failures, 'history:runs', dom.history?.runs ?? null, semantic.history.runs)
        compare(
          failures,
          'history:trace-lost',
          (dom.history?.traceLost ?? '') !== '',
          semantic.history.traceLost
        )
        compare(failures, 'history:no-zero-tokens', /\b0 tokens\b/.test(dom.bodyText), false)
      } else {
        compare(failures, 'history:absent', dom.history, null)
      }
      compare(failures, 'semantic:delivered-text', dom.bodyText.includes('Delivered'), semantic.deliveredExpected)
    } else {
      const errorNode = dom.testIds['task-workbench-fixture-error'] ?? 0
      compare(failures, 'fixture:error-node', errorNode, 1)
      failures.push({ name: 'fixture:unknown', expected: 'a known fixture key', actual: entry.fixture })
    }

    const cdp = await page.context().newCDPSession(page)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buffer = Buffer.from(data, 'base64')
    const screenshotFile = `task-workbench-${entry.fixture}-${entry.width}x${entry.height}.png`
    writeFileSync(path.join(outputRoot, screenshotFile), buffer)
    const png = readPngSize(buffer)
    report.screenshot = { file: screenshotFile, ...png }
    compare(
      failures,
      'screenshot:size',
      png,
      {
        width: Math.round(dom.viewport.width * dom.viewport.devicePixelRatio),
        height: Math.round(dom.viewport.height * dom.viewport.devicePixelRatio)
      }
    )

    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    )
    report.windows = windows
    compare(failures, 'windows:count', windows.length, 1)
    compare(failures, 'windows:hidden-unfocused', windows.every((window) => !window.visible && !window.focused), true)
    compare(failures, 'pageerror:count', pageErrors.length, 0)
  } catch (error) {
    failures.push({
      name: 'run:exception',
      expected: 'a completed run',
      actual: error instanceof Error ? error.message : String(error)
    })
  } finally {
    report.pageErrors = pageErrors
    report.consoleErrors = consoleErrors
    report.failures = failures
    report.pass = failures.length === 0
    report.durationMs = Date.now() - startedAt
    const reportFile = `task-workbench-${entry.fixture}-${entry.width}x${entry.height}.report.json`
    report.reportFile = reportFile
    writeFileSync(path.join(outputRoot, reportFile), `${JSON.stringify(report, null, 2)}\n`)
    if (app) {
      await app.close().catch(() => {})
    }
  }
  return report
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node tests/tools/task-workbench-rendered/run.mjs --fixture <key> --width <n> --height <n>')
    console.log('       node tests/tools/task-workbench-rendered/run.mjs --all [--calibrate]')
    return
  }
  const startedAt = Date.now()
  const builds = await prepareBuilds()
  const runs = options.all
    ? [...SHOT_MATRIX, ...(options.calibrate ? CALIBRATION_MATRIX : [])]
    : [{ id: 'single', fixture: options.fixture, width: options.width, height: options.height }]
  const reports = []
  for (const entry of runs) {
    const report = await runOne(entry, builds)
    reports.push(report)
    const label = entry.id === null ? 'single' : entry.id
    const verdict = report.pass ? 'PASS' : 'FAIL'
    console.log(
      `${verdict} ${label} ${entry.fixture} ${entry.width}x${entry.height} (${report.durationMs} ms)`
    )
    if (!report.pass) {
      console.error(`  failures: ${report.failures.map((failure) => failure.name).join(', ')}`)
    }
  }
  if (options.all) {
    const summary = {
      scope: SCOPE,
      runs: reports.map((report) => ({
        run: report.run,
        fixture: report.fixture,
        size: `${report.requested.width}x${report.requested.height}`,
        extraCalibration: report.extraCalibration,
        mandatory: report.mandatory,
        pass: report.pass,
        failures: report.failures.map((failure) => failure.name),
        reportFile: report.reportFile,
        screenshot: report.screenshot ?? null
      })),
      passed: reports.filter((report) => report.pass).length,
      failed: reports.filter((report) => !report.pass).length,
      totalWallMs: Date.now() - startedAt
    }
    writeFileSync(path.join(outputRoot, 'task-workbench-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`summary: ${summary.passed}/${summary.runs.length} passed, ${summary.totalWallMs} ms`)
  }
  if (reports.some((report) => !report.pass)) {
    process.exitCode = 1
  }
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
