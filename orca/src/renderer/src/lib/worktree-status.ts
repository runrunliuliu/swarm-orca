import { resolveAgentTypeFromTerminalTitle } from '@/components/sidebar/worktree-title-derived-agent-rows'
import type { TitleDerivedPaneForeground } from '@/components/sidebar/title-derived-pane-agent-identity'
import {
  classifyTitleActivity,
  paneHasNoStatusEvidence,
  titleClaimsStatus
} from '@/lib/pane-agent-evidence'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { resolveRuntimePaneTitleLeafIdFromRoot } from '@/lib/runtime-pane-title-leaf-id'
import { containsAgentSpinnerGlyph } from '../../../shared/agent-title-core'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { titleShowsNoAgent } from '../../../shared/shell-process-detection'
import { isSyntheticAgentPermissionTitle } from '../../../shared/synthetic-agent-title'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LiveAgentWorktreeStatus } from './worktree-activity-state'

export type WorktreeStatus =
  | 'active'
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'failed'
  | 'interrupted'
  | 'done'
  // Why: a live pane Orca can name as an agent that has reported no status at all —
  // distinct from 'active' (a quiet shell) and from 'done' (a claim nothing supports).
  // See paneHasNoStatusEvidence: the card says "no status reported" rather than
  // letting an unreporting agent look like an idle terminal forever.
  | 'no-evidence'
  | 'inactive'

type WorktreeStatusHeuristicOptions = {
  liveAgentStatus?: LiveAgentWorktreeStatus
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  /** Stale rows suppress Orca's generated permission labels; native title fallback stays live. */
  stalePaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
  /** Process-read identity per pane. A launch record alone is not identity — see the row builder. */
  paneForegroundAgentByPaneKey?: Record<string, TitleDerivedPaneForeground>
}

const STATUS_LABELS: Record<WorktreeStatus, string> = {
  active: 'Active',
  working: 'Working',
  monitoring: 'Monitoring background tasks',
  permission: 'Needs permission',
  failed: 'Failed',
  interrupted: 'Interrupted',
  done: 'Done',
  'no-evidence': 'No status reported',
  inactive: 'Inactive'
}

export function getWorktreeStatus(
  tabs: readonly Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>[],
  browserTabs: readonly { id: string }[],
  ptyIdsByTabId: Record<string, string[]>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {},
  options: WorktreeStatusHeuristicOptions = {}
): WorktreeStatus {
  // Why: tab.ptyId is a wake-hint that survives sleep, not a liveness signal; gate on ptyIdsByTabId, which sleep/kill clear when the PTY dies.
  const liveTabs = tabs.filter((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))

  // Why: tab.title tracks only the most-recently-focused pane (onActivePaneChange in use-terminal-pane-lifecycle.ts); consult per-pane titles so the spinner reflects aggregate tab state.
  const hasStatus = (status: 'permission' | 'working'): boolean =>
    liveTabs.some((tab) => tabHasStatus(tab, runtimePaneTitlesByTabId, status, options))

  if (options.liveAgentStatus === 'permission' || hasStatus('permission')) {
    return 'permission'
  }
  if (options.liveAgentStatus === 'working' || hasStatus('working')) {
    return 'working'
  }
  if (options.liveAgentStatus === 'monitoring') {
    return 'monitoring'
  }
  if (liveTabs.length > 0 || browserTabs.length > 0) {
    // Why: an agent pane that never reported is the one live fact the user cannot infer
    // from a green 'active' dot, so it is named instead of borrowed by "terminal open,
    // quiet". A worktree whose live panes are plain shells keeps reading 'active'.
    if (liveTabs.some((tab) => tabHasUnreportedAgent(tab, runtimePaneTitlesByTabId, options))) {
      return 'no-evidence'
    }
    // Why: browser-only worktrees (no PTY) are still active from the user's point of view.
    return 'active'
  }
  return 'inactive'
}

/** The tab facts this heuristic reads; full tabs satisfy it, and so do test literals. */
type UnreportedAgentTab = {
  id: string
  title: string
  launchAgent?: TerminalTab['launchAgent']
  defaultTitle?: string
}

/**
 * Whether this tab holds a pane that names an agent, has a live PTY, and claims no
 * status: not a fresh row, not a stale one, and no title activity. The pane-level rule
 * lives in `paneHasNoStatusEvidence`; this only supplies the per-pane facts, using the
 * same pane-to-leaf resolution as `tabHasStatus` so the two cannot disagree about which
 * pane an id belongs to.
 */
function tabHasUnreportedAgent(
  tab: UnreportedAgentTab,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  options: WorktreeStatusHeuristicOptions
): boolean {
  const freshPaneIds = options.agentStatusPaneIdsByTabId?.[tab.id]
  const stalePaneIds = options.stalePaneIdsByTabId?.[tab.id]
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  const paneTitleEntries = paneTitles ? Object.entries(paneTitles) : []
  if (paneTitleEntries.length === 0) {
    return paneHasNoStatusEvidence({
      hasAgentIdentity: paneIdentifiesAgent({
        tab,
        title: tab.title,
        leafId: onlyPaneLeafId(tab.id, options),
        options
      }),
      hasLivePty: true,
      hasHookClaim: Boolean(freshPaneIds?.size || stalePaneIds?.size),
      hasTitleClaim: titleClaimsStatus(tab.title)
    })
  }
  const tabLayoutRoot =
    options.terminalLayoutRootsByTabId?.[tab.id] ?? options.terminalLayoutsByTabId?.[tab.id]?.root
  return paneTitleEntries.some(([runtimePaneId, title]) => {
    const leafId = resolveRuntimePaneTitleLeafIdFromRoot(tabLayoutRoot, runtimePaneId)
    return paneHasNoStatusEvidence({
      hasAgentIdentity: paneIdentifiesAgent({ tab, title, leafId, options }),
      hasLivePty: true,
      hasHookClaim: Boolean(
        freshPaneIds?.has(runtimePaneId) ||
        (leafId !== null && freshPaneIds?.has(leafId)) ||
        stalePaneIds?.has(runtimePaneId) ||
        (leafId !== null && stalePaneIds?.has(leafId))
      ),
      hasTitleClaim: titleClaimsStatus(title)
    })
  })
}

/**
 * The leaf a tab-level title belongs to: the active leaf when the caller carries a full
 * layout, else the root itself when the tab is a single pane. Callers that only select
 * `terminalLayoutRootsByTabId` (the sidebar) take the second path.
 */
function onlyPaneLeafId(tabId: string, options: WorktreeStatusHeuristicOptions): string | null {
  const layout = options.terminalLayoutsByTabId?.[tabId]
  if (layout) {
    return layout.activeLeafId
  }
  const root = options.terminalLayoutRootsByTabId?.[tabId]
  return root?.type === 'leaf' ? root.leafId : null
}

/**
 * Whether this pane's OWN evidence names an agent: a title that presents one, or a live
 * process read. Deliberately not `launchAgent` — that is a tab-scoped latch with no run id, and
 * the row builder rejects it for a plain title ("never keeps a plain-title row on the launch
 * record alone"). Reading it here would let the card claim an agent the sidebar does not show.
 */
function paneIdentifiesAgent(args: {
  tab: UnreportedAgentTab
  title: string
  leafId: string | null
  options: WorktreeStatusHeuristicOptions
}): boolean {
  if (resolveAgentTypeFromTerminalTitle(args.title) !== null) {
    return true
  }
  if (args.leafId === null) {
    return false
  }
  const foreground =
    args.options.paneForegroundAgentByPaneKey?.[makePaneKey(args.tab.id, args.leafId)]
  // Why: a read that predates the shell's return is not identity (see `titleRetiresProcessRead`
  // in the row builder), and a reattach's launch-record seed is not a read at all.
  return (
    foreground?.agentEvidence === 'process-read' &&
    foreground.agent !== null &&
    !titleShowsNoAgent(args.title, args.tab.defaultTitle)
  )
}

function tabHasStatus(
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): boolean {
  const freshPaneIds = options.agentStatusPaneIdsByTabId?.[tab.id]
  const permissionPaneIds = suppressingPaneIds(tab.id, status, options)
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    const tabLayoutRoot =
      options.terminalLayoutRootsByTabId?.[tab.id] ?? options.terminalLayoutsByTabId?.[tab.id]?.root
    const paneTitleEntries = Object.entries(paneTitles)
    for (const [runtimePaneId, title] of paneTitleEntries) {
      const agentStatusPaneIds =
        status === 'permission' && isSyntheticAgentPermissionTitle(title)
          ? permissionPaneIds
          : freshPaneIds
      const leafId = resolveRuntimePaneTitleLeafIdFromRoot(tabLayoutRoot, runtimePaneId)
      // Why: runtime titles can precede layout hydration (SSH/replay); with one title and one agent row, prefer that row over a stale spinner.
      const hasSingleUnmappedAgentStatusPane =
        leafId === null && agentStatusPaneIds?.size === 1 && paneTitleEntries.length === 1
      if (
        agentStatusPaneIds?.has(runtimePaneId) ||
        (leafId !== null && agentStatusPaneIds?.has(leafId)) ||
        hasSingleUnmappedAgentStatusPane
      ) {
        continue
      }
      if (
        classifyTitleActivity(title) === status &&
        titleStatusIsAgentAttributable(title, tab.launchAgent)
      ) {
        return true
      }
    }
    return false
  }
  // Why: a tab title can't identify its pane; once an agent row owns one, prefer the row over a completed pane's stale "working" title.
  const agentStatusPaneIds =
    status === 'permission' && isSyntheticAgentPermissionTitle(tab.title)
      ? permissionPaneIds
      : freshPaneIds
  if (agentStatusPaneIds && agentStatusPaneIds.size > 0) {
    return false
  }
  return (
    classifyTitleActivity(tab.title) === status &&
    titleStatusIsAgentAttributable(tab.title, tab.launchAgent)
  )
}

/**
 * Pane ids whose title must not drive `status` for this tab. Fresh rows suppress every heuristic;
 * stale rows suppress synthetic permission labels only. Returns the fresh set itself
 * when there is nothing to add, so the common path allocates nothing.
 */
function suppressingPaneIds(
  tabId: string,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): ReadonlySet<string> | undefined {
  const fresh = options.agentStatusPaneIdsByTabId?.[tabId]
  if (status !== 'permission') {
    return fresh
  }
  const stale = options.stalePaneIdsByTabId?.[tabId]
  if (!stale || stale.size === 0) {
    return fresh
  }
  if (!fresh || fresh.size === 0) {
    return stale
  }
  return new Set([...fresh, ...stale])
}

// Why: require agent attribution so a bare never-cleared spinner title can't spin the dot "0 agents" forever with no matching sidebar row.
function titleStatusIsAgentAttributable(title: string, launchAgent?: TuiAgent | null): boolean {
  if (resolveAgentTypeFromTerminalTitle(title) !== null) {
    return true
  }
  // Why: a spinner proves activity but not identity (Claude's thinking title has no provider
  // token, #9040); the tab's launch identity supplies it, mirroring the row builder's spinner
  // fallback (#9647) so the dot and the sidebar row agree.
  return containsAgentSpinnerGlyph(title) && Boolean(launchAgent)
}

export function getWorktreeStatusLabel(status: WorktreeStatus): string {
  return STATUS_LABELS[status]
}

/**
 * Apply the WorktreeCard priority overlay on top of the title-heuristic base. Explicit agent rows may
 * promote the dot; sleep cleanup owns removing stale retained rows.
 *
 * Map args are narrowed to this worktree. `hasPermission`/`hasLiveWorking`/
 * `hasLiveDone` are fresh hook entries ({blocked,waiting} / {working} / {done});
 * `hasRetainedDone`/`hasRetainedFailed` are retained-agent snapshots scoped to this worktreeId.
 */
export function resolveWorktreeStatus(args: {
  tabs: readonly Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>[]
  browserTabs: readonly { id: string }[]
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  stalePaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
  paneForegroundAgentByPaneKey?: Record<string, TitleDerivedPaneForeground>
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring?: boolean
  hasFailed?: boolean
  hasInterrupted?: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
  hasRetainedFailed?: boolean
}): WorktreeStatus {
  const heuristic = getWorktreeStatus(
    args.tabs,
    args.browserTabs,
    args.ptyIdsByTabId,
    args.runtimePaneTitlesByTabId ?? {},
    {
      agentStatusPaneIdsByTabId: args.agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId: args.stalePaneIdsByTabId,
      terminalLayoutsByTabId: args.terminalLayoutsByTabId,
      terminalLayoutRootsByTabId: args.terminalLayoutRootsByTabId,
      paneForegroundAgentByPaneKey: args.paneForegroundAgentByPaneKey
    }
  )
  if (args.hasPermission) {
    return 'permission'
  }
  // Why: heuristic 'permission' outranks heuristic 'working' — the user-actionable signal wins when panes in one tab disagree.
  if (heuristic === 'permission') {
    return 'permission'
  }
  // Why: a failure is news, so it outranks live work (a failed main agent's subagents may still
  // run); only a pending question comes first.
  if (args.hasFailed) {
    return 'failed'
  }
  // Why: restored cards get the hook snapshot before panes mount; trust the explicit working row so they stay yellow on restart.
  if (args.hasLiveWorking || heuristic === 'working') {
    return 'working'
  }
  if (args.hasLiveMonitoring || heuristic === 'monitoring') {
    return 'monitoring'
  }
  // Why: a departed agent's failure has no expiry, so it must not pin the card over live work.
  if (args.hasRetainedFailed) {
    return 'failed'
  }
  // A stop follows live states, but must not collapse into success.
  if (args.hasInterrupted) {
    return 'interrupted'
  }
  if (args.hasLiveDone || args.hasRetainedDone) {
    return 'done'
  }
  // Why: every reported state returned above, so `no-evidence` can only reach here as the
  // quietest LIVE answer — it never displaces a claim, and never stands in for one.
  return heuristic
}
