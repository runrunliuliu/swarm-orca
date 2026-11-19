/**
 * @vitest-environment happy-dom
 */
import '@testing-library/jest-dom/vitest'

import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentRowState } from '@/lib/agent-row-decay-state'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeContextMenu from './WorktreeContextMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * The sidebar delivery entry (README §7.11.3 rules 1, 4, 7, §7.11.5): a
 * `交付…` item rendered directly above `归档`, in one-workspace context only,
 * driven by the same `projectTaskWorkbenchDeliver` the Delivery fact row reads,
 * and submitting through the same launcher with `source: 'sidebar'`.
 *
 * Why the launch module is mocked: it is the store edge (it reads the live tab
 * model and starts a tab). Its own re-check is proven in
 * `lib/task-workbench/task-workbench-deliver-launch.test.ts`; here the fact
 * under test is the call — one launch, the clicked workspace, the sidebar
 * source — so mocking it is what makes "exactly once" observable.
 *
 * Why the agent rows come from a mocked `useWorktreeAgentRows`: that hook is the
 * sidebar's existing per-worktree row pipeline (store slices → buckets →
 * conversation names), and its own behaviour is covered by its own tests. What
 * this file pins is that the *menu* asks that pipeline and hands the answer to
 * the frozen projection instead of inventing a sixth-state rule of its own.
 */

const launchModule = vi.hoisted(() => ({
  launchTaskWorkbenchDeliver: vi.fn(),
  revealTaskWorkbenchDeliverTab: vi.fn(),
  // Why the real pair: the sidebar reads the frozen no-agent notice from the
  // launcher module (F6, one export both hosts import), so a mock without it
  // would hide a broken consumption behind an `undefined` toast.
  TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE: {
    key: 'auto.components.Terminal.5b2c1a9e44',
    fallback: 'No agent CLI detected — install one or pick a default agent in Settings.'
  }
}))
vi.mock('@/lib/task-workbench/task-workbench-deliver-launch', () => launchModule)

const toastModule = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastModule.error, success: vi.fn() } }))

const agentRowsModule = vi.hoisted(() => {
  const rows: DashboardAgentRow[] = []
  return { rows }
})
vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: (): DashboardAgentRow[] => agentRowsModule.rows
}))

const WORKING_REASON = 'A working agent already owns this workspace; delivery waits for one writer.'
const DELIVER_LABEL = 'Deliver…'
const OPEN_TERMINAL_LABEL = 'Open terminal'
const NO_AGENT_FALLBACK =
  'No agent CLI detected — install one or pick a default agent in Settings.'
const ARCHIVE_LABEL = 'Archive workspace'
const DELETE_LABEL = 'Delete'

const REPO_ID = 'repo'
const WORKTREE_ID = 'repo::wt-1'

const noFolderWorkspaces: FolderWorkspace[] = []

const state = {
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: [],
  openModal: vi.fn(),
  projectGroups: [],
  createProjectGroup: vi.fn(),
  moveProjectToGroup: vi.fn(),
  deleteStateByWorktreeId: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  updateWorktreeLineage: vi.fn(),
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  browserTabsByWorktree: {},
  keybindings: {},
  settings: { activeRuntimeEnvironmentId: null, openInApplications: [] },
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  folderWorkspaces: noFolderWorkspaces,
  updateFolderWorkspace: vi.fn().mockResolvedValue(true)
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

// Why mutable: the repo's main worktree row is the only source the sidebar has
// for the confirm's default target branch, and one case needs it absent.
const allWorktreesModule = vi.hoisted(() => {
  const rows: Worktree[] = []
  return { rows }
})
vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => allWorktreesModule.rows,
  useRepoById: (repoId?: string) =>
    repoId
      ? { id: repoId, name: repoId, displayName: 'acme/web-app', projectGroupId: null }
      : undefined,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/i18n/i18n', () => ({
  // Why interpolation: two assertions read a template sentence (the batch
  // archive label and the confirmation heading), and a mock that dropped
  // `{{value0}}` would make them pass on the wrong string.
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    Object.entries(vars ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
      fallback
    ),
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => null,
  formatShortcutLabel: () => '',
  formatOptionalShortcutLabel: () => null
}))

// Why: the real catalog imports resources/*.png, which a sparse checkout cannot resolve.
vi.mock('@/lib/agent-catalog', () => ({
  AGENT_CATALOG: [],
  AgentIcon: () => null,
  agentTypeToIconAgent: (agentType: string) => agentType,
  getAgentCatalog: () => [],
  getAgentLabel: (agent: string) => agent
}))

vi.mock('lucide-react', async () =>
  (await import('../tab-bar/lucide-icon-stub-fixture')).stubEveryIcon()
)

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))
vi.mock('./WorktreeDeveloperMenu', () => ({ WorktreeDeveloperMenu: () => null }))
vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))
vi.mock('./WorkspaceSleepMenuItems', () => ({ WorkspaceSleepMenuItems: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  state.folderWorkspaces = []
  agentRowsModule.rows = []
  allWorktreesModule.rows = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText: vi.fn() }, runtime: { call: vi.fn() } }
  })
})

afterEach(cleanup)

function worktreeFixture(overrides: Partial<Worktree> = {}): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu reads only the fields set here.
  return {
    id: WORKTREE_ID,
    repoId: REPO_ID,
    displayName: 'Fix authentication race',
    branch: 'refs/heads/feature/auth-race',
    path: '/path/to/wt-1',
    isMainWorktree: false,
    isArchived: false,
    ...overrides
  } as Worktree
}

function mainWorktreeFixture(): Worktree {
  return worktreeFixture({
    id: 'repo::main',
    displayName: 'main',
    branch: 'refs/heads/main',
    path: '/path/to/main',
    isMainWorktree: true
  })
}

function folderWorkspaceFixture(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Draft task',
    folderPath: '/tmp/task-drafts/draft-1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

/** One sidebar agent row, in the shape the mocked row pipeline returns. */
function agentRow(rowState: AgentRowState, quickCommandLabel?: string): DashboardAgentRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the projection reads are set.
  return {
    paneKey: 'tab-1:leaf-1',
    entry: { paneKey: 'tab-1:leaf-1', state: rowState, stateStartedAt: 1, updatedAt: 1 },
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: WORKTREE_ID,
      title: 'Agent',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      ...(quickCommandLabel ? { quickCommandLabel } : {})
    },
    agentType: 'claude',
    state: rowState,
    startedAt: 1
  } as unknown as DashboardAgentRow
}

function openMenu(
  worktree: Worktree = worktreeFixture(),
  options: { selectedWorktrees?: readonly Worktree[] } = {}
): { rerender: (next?: Worktree) => void } {
  const element = (target: Worktree) => (
    <TooltipProvider>
      <WorktreeContextMenu
        worktree={target}
        {...(options.selectedWorktrees ? { selectedWorktrees: options.selectedWorktrees } : {})}
      >
        <div>Card</div>
      </WorktreeContextMenu>
    </TooltipProvider>
  )
  const view = render(element(worktree))
  const scope = document.querySelector('[data-worktree-context-menu-scope]')
  act(() => {
    scope?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
  // Why a handle: the K1 cases open the confirmation while the row is idle and
  // then let the projection change (a Working owner, an archive, a marker tab)
  // before submitting. Re-rendering the same root is what makes the row pipeline
  // report the new rows, exactly as a live store update would.
  return { rerender: (next: Worktree = worktree) => view.rerender(element(next)) }
}

function menuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}

function menuItemLabels(): string[] {
  return menuItems().map((item) => (item.textContent ?? '').trim())
}

function menuItem(label: string): HTMLElement {
  const item = menuItems().find((element) => (element.textContent ?? '').trim() === label)
  // Why a throw and not an assertion: `expect(...).toBeTruthy()` does not narrow
  // the type, and the menu item is either there or the test is wrong.
  if (!item) {
    throw new Error(`menu item "${label}" was not rendered`)
  }
  return item
}

function clickMenuItem(label: string): void {
  const item = menuItem(label)
  // Why: the menu swallows clicks until a primary pointerdown proves they are
  // not the right-click that opened it.
  act(() => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item.click()
  })
}

/** The same click, for the paths that load the launcher on demand: the handler's
 *  promise settles inside this async act, so the assertion after it is a plain
 *  post-condition instead of a poll. */
async function clickMenuItemAsync(label: string): Promise<void> {
  const item = menuItem(label)
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item.click()
  })
}

describe('sidebar deliver entry — where it sits', () => {
  it('renders Deliver… directly above Archive workspace, with Delete last', () => {
    openMenu()

    // One assertion, over what the DOM actually rendered: the menu's lifecycle
    // order is 交付 → 归档 → 移除.
    const labels = menuItemLabels()
    const deliverIndex = labels.indexOf(DELIVER_LABEL)
    const archiveIndex = labels.indexOf(ARCHIVE_LABEL)

    expect(deliverIndex).toBeGreaterThanOrEqual(0)
    expect(archiveIndex).toBe(deliverIndex + 1)
    expect(labels.at(-1)).toBe(DELETE_LABEL)
    expect(document.querySelectorAll('[data-testid="worktree-context-menu-deliver"]')).toHaveLength(
      1
    )
  })
})

describe('sidebar deliver entry — when it is offered', () => {
  it('is present for one live workspace', () => {
    openMenu()

    expect(screen.getByTestId('worktree-context-menu-deliver')).toHaveTextContent(DELIVER_LABEL)
    expect(screen.getByTestId('worktree-context-menu-deliver')).toBeEnabled()
  })

  it('is absent for a multi-workspace selection', () => {
    openMenu(worktreeFixture(), {
      selectedWorktrees: [worktreeFixture(), worktreeFixture({ id: 'repo::wt-2' })]
    })

    expect(screen.queryByTestId('worktree-context-menu-deliver')).toBeNull()
    // The batch Archive row is what this context actually offers.
    expect(menuItemLabels()).toContain('Archive 2 workspaces')
  })

  it('is absent for a task draft row', () => {
    const draft = folderWorkspaceFixture({ taskDraft: true })
    state.folderWorkspaces = [draft]
    openMenu(folderWorkspaceToWorktree(draft))

    expect(screen.queryByTestId('worktree-context-menu-deliver')).toBeNull()
    expect(menuItemLabels()).toContain('Archive draft')
  })

  it('is absent for an archived workspace, which still keeps its Archive row', () => {
    openMenu(worktreeFixture({ isArchived: true }))

    expect(screen.queryByTestId('worktree-context-menu-deliver')).toBeNull()
    expect(menuItemLabels()).toContain(ARCHIVE_LABEL)
  })
})

describe('sidebar deliver entry — one writer', () => {
  it('disables Deliver… and states the reason on the title and in sr-only text', () => {
    agentRowsModule.rows = [agentRow('working')]
    openMenu()

    const item = screen.getByTestId('worktree-context-menu-deliver')
    expect(item).toHaveTextContent(DELIVER_LABEL)
    expect(item).toHaveAttribute('aria-disabled', 'true')
    // Rule 4: the reason travels with the item — `title` for pointer and
    // keyboard readers, plus sr-only text the item describes itself with.
    expect(item).toHaveAttribute('title', WORKING_REASON)
    const describedBy = item.getAttribute('aria-describedby')
    const reason = document.getElementById(describedBy ?? '')
    expect(reason).toHaveTextContent(WORKING_REASON)
    expect(reason).toHaveClass('sr-only')

    clickMenuItem(DELIVER_LABEL)
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  // K6: Radix's own `disabled` sets `focusable: false` and drops the item from
  // arrow-key navigation, so the reason was only reachable in browse mode. The
  // assertions below are the focus path, not the attributes: the item takes
  // focus, and Enter (the activation key) neither launches nor closes the menu.
  it('keeps the one-writer item keyboard-focusable and refuses keyboard activation', () => {
    agentRowsModule.rows = [agentRow('working')]
    openMenu()

    const item = screen.getByTestId('worktree-context-menu-deliver')
    expect(item).toHaveAttribute('aria-disabled', 'true')
    // A Radix `disabled` item also carries `data-disabled` and loses pointer
    // events; the aria-disabled shape deliberately does not.
    expect(item).not.toHaveAttribute('data-disabled')

    act(() => item.focus())
    expect(document.activeElement).toBe(item)
    // The description is attached to the element that actually holds focus.
    expect(item.getAttribute('aria-describedby')).toBeTruthy()

    act(() => {
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
    // `onSelect` is prevented, so the menu stays open on the focused item.
    expect(screen.getByTestId('worktree-context-menu-deliver')).toBe(item)
    expect(document.activeElement).toBe(item)
  })
})

describe('sidebar deliver entry — opening and submitting', () => {
  it('opens the imported confirmation, pre-filled from the repo main worktree branch', () => {
    allWorktreesModule.rows = [mainWorktreeFixture(), worktreeFixture()]
    openMenu()

    clickMenuItem(DELIVER_LABEL)

    const panel = screen.getByTestId('task-workbench-deliver-confirm')
    expect(panel).toHaveTextContent('acme/web-app · Fix authentication race')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('task-workbench-deliver-target-branch')).toHaveValue('main')
    expect(screen.getByTestId('task-workbench-deliver-target-branch-default')).toHaveTextContent(
      'Default · needs confirmation'
    )
    expect(screen.getByTestId('task-workbench-deliver-submit')).toHaveAttribute(
      'data-variant',
      'outline'
    )
  })

  it('launches exactly once with source sidebar and the clicked workspace id', async () => {
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: true, tabId: 'tab-deliver' })
    allWorktreesModule.rows = [mainWorktreeFixture(), worktreeFixture()]
    openMenu()

    clickMenuItem(DELIVER_LABEL)
    fireEvent.change(screen.getByTestId('task-workbench-deliver-target-branch'), {
      target: { value: 'release/2026-11' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))
    })

    expect(launchModule.launchTaskWorkbenchDeliver).toHaveBeenCalledTimes(1)
    expect(launchModule.launchTaskWorkbenchDeliver).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      targetBranch: 'release/2026-11',
      integrationMode: 'pr',
      archiveAfter: false,
      source: 'sidebar'
    })
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  it('blocks submit when no main worktree branch is known, and launches nothing', () => {
    openMenu()

    clickMenuItem(DELIVER_LABEL)

    expect(screen.getByTestId('task-workbench-deliver-target-branch')).toHaveValue('')
    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeDisabled()
    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
  })

  it('shows Open terminal for an existing DELIVER session and reveals it without launching', async () => {
    launchModule.revealTaskWorkbenchDeliverTab.mockReturnValue(true)
    agentRowsModule.rows = [agentRow('done', 'DELIVER')]
    openMenu()

    // K5: the position keeps the frozen `openTerminal` verb, the same one the
    // Delivery fact row uses; only the state word changes, never the action.
    // The earlier version clicked `交付…` here and thereby accepted the
    // mismatch (the label promised a delivery that was actually a reveal).
    const item = screen.getByTestId('worktree-context-menu-deliver')
    expect(item).toHaveTextContent(OPEN_TERMINAL_LABEL)
    expect(item).not.toHaveTextContent(DELIVER_LABEL)
    expect(screen.queryByText(DELIVER_LABEL)).toBeNull()

    await clickMenuItemAsync(OPEN_TERMINAL_LABEL)

    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledTimes(1)
    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledWith(WORKTREE_ID)
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
  })

  it('opens the shared confirmation after a failed reveal, then retries reveal without launching', async () => {
    launchModule.revealTaskWorkbenchDeliverTab.mockReturnValue(false)
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: true, tabId: 'tab-deliver' })
    agentRowsModule.rows = [agentRow('done', 'DELIVER')]
    allWorktreesModule.rows = [mainWorktreeFixture(), worktreeFixture()]
    openMenu()

    await clickMenuItemAsync(OPEN_TERMINAL_LABEL)

    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledTimes(1)
    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledWith(WORKTREE_ID)
    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))
    })

    // Submit deliberately re-projects the still-present marker row. Existing-
    // session precedence retries reveal and closes the shared panel; it cannot
    // launch past that row even when both reveal attempts return false.
    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledTimes(2)
    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenLastCalledWith(WORKTREE_ID)
    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  it('surfaces the exported frozen no-agent notice and keeps the panel open', async () => {
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: false, reason: 'no-agent' })
    allWorktreesModule.rows = [mainWorktreeFixture(), worktreeFixture()]
    openMenu()

    clickMenuItem(DELIVER_LABEL)
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))
    })

    // F6: the sentence comes from the launcher module's single export, not a
    // second copy in this host.
    expect(toastModule.error).toHaveBeenCalledWith(NO_AGENT_FALLBACK)
    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()
  })
})

describe('sidebar deliver entry — submit re-projects before launching', () => {
  function openIdleConfirmation(): { rerender: (next?: Worktree) => void } {
    allWorktreesModule.rows = [mainWorktreeFixture(), worktreeFixture()]
    const menu = openMenu()
    clickMenuItem(DELIVER_LABEL)
    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()
    return menu
  }

  async function submit(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))
    })
  }

  // K1: the confirmation is hosted outside the menu and outlives the projection
  // it was opened under. A Working owner that appears while it is open must
  // make submit refuse — the launcher re-checks the DELIVER marker, not
  // eligibility, so this host is the last guard.
  it('launches nothing when a working agent appears after the confirmation opened', async () => {
    // Why a successful launch is mocked: without the guard this test must fail
    // on the observed launch, not on a TypeError from an unset mock.
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: true, tabId: 'tab-deliver' })
    const menu = openIdleConfirmation()

    agentRowsModule.rows = [agentRow('working')]
    menu.rerender()

    await submit()

    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
    expect(toastModule.error).toHaveBeenCalledWith(WORKING_REASON)
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  // K1: an archive between opening and submitting removes the whole action from
  // the projection; submit must not launch into a workspace that is now history.
  it('launches nothing when the workspace is archived after the confirmation opened', async () => {
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: true, tabId: 'tab-deliver' })
    const menu = openIdleConfirmation()

    menu.rerender(worktreeFixture({ isArchived: true }))

    await submit()

    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
    // The frozen vocabulary has one refusal sentence for "not deliverable now";
    // no archive-specific key exists and this slice adds none.
    expect(toastModule.error).toHaveBeenCalledWith(WORKING_REASON)
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  // Rule 4 order: an existing session outranks the one-writer guard, so a
  // marker that appears after opening is revealed, not launched past.
  it('reveals a session that appeared after the confirmation opened, and launches nothing', async () => {
    launchModule.revealTaskWorkbenchDeliverTab.mockReturnValue(true)
    const menu = openIdleConfirmation()

    agentRowsModule.rows = [agentRow('working'), agentRow('done', 'DELIVER')]
    menu.rerender()

    await submit()

    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledWith(WORKTREE_ID)
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })
})
