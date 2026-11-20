// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type {
  AgentRowView,
  TaskWorkbenchLayout,
  TaskWorkbenchView,
  TaskWorkbenchWorkspace
} from './task-workbench-view'

/**
 * The Delivery fact row's delivery entry (README §7.11.3 rules 1, 2, 4, 8,
 * §7.11.5): which of the projection's four shapes is on screen, and what the one
 * launch site does with the confirmation's three values.
 *
 * Why the launch module is mocked: it is the store edge (it reads the live tab
 * model and starts a tab). Its own guarantees — the synchronous re-check, the
 * empty tab id on a host-published launch — are proven in
 * `lib/task-workbench/task-workbench-deliver-launch.test.ts`; here the count of
 * calls is the fact under test, so mocking it is what makes "exactly once"
 * observable instead of inferred.
 *
 * Every expectation is a literal from SHARED-CONTEXT: the frozen test ids, the
 * frozen copy, and the four states the projection can emit.
 */

const launchModule = vi.hoisted(() => ({
  launchTaskWorkbenchDeliver: vi.fn(),
  revealTaskWorkbenchDeliverTab: vi.fn(),
  // The shared no-agent pair (F6) is a value import; the mock factory must
  // provide it. Pinned as the literal from SHARED-CONTEXT, like NO_AGENT_COPY.
  TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE: {
    key: 'auto.components.Terminal.5b2c1a9e44',
    fallback: 'No agent CLI detected — install one or pick a default agent in Settings.'
  }
}))
vi.mock('@/lib/task-workbench/task-workbench-deliver-launch', () => launchModule)

const toastModule = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastModule.error, success: vi.fn() } }))

import { TaskWorkbenchDelivery } from './TaskWorkbenchDelivery'

const NO_AGENT_COPY =
  'No agent CLI detected — install one or pick a default agent in Settings.'
const WORKING_REASON =
  'A working agent already owns this workspace; delivery waits for one writer.'

const LAYOUT: TaskWorkbenchLayout = {
  columns: 'single',
  delivery: 'collapsed',
  agentHistory: 'collapsed',
  spend: 'summary',
  workspaces: 'full'
}

const WORKSPACE: TaskWorkbenchWorkspace = {
  repoId: 'repo-web-app',
  worktreeId: 'wt-feat-431',
  repoName: 'acme/web-app',
  worktreeName: 'feat/task-431',
  branchName: 'feat/task-431',
  hostKind: 'local',
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  workspaceKind: 'worktree'
}

function agentRow(bucket: DashboardCard['bucket'], conversationName?: string): AgentRowView {
  return {
    base: {
      paneKey: 'pane-1',
      ptyId: 'pty-1',
      agentType: 'claude',
      bucket,
      dotState: bucket === 'working' ? 'working' : 'idle',
      task: 'do the thing',
      repoId: WORKSPACE.repoId,
      worktreeId: WORKSPACE.worktreeId,
      tabId: 'tab-1',
      leafId: 'leaf-1',
      repoName: WORKSPACE.repoName,
      worktreeName: WORKSPACE.worktreeName,
      ...(conversationName ? { conversationName } : {}),
      startedAt: 1,
      finishedAt: bucket === 'working' ? null : 2,
      stateChangedAt: 1,
      unseen: false
    },
    tokens: { kind: 'unavailable', reason: 'unattributed' }
  }
}

function makeView(overrides: Partial<TaskWorkbenchView> = {}): TaskWorkbenchView {
  return {
    identity: { kind: 'workspace', primaryWorktreeId: WORKSPACE.worktreeId },
    title: 'Delivery action',
    defaultWorkspace: { workspaceId: WORKSPACE.worktreeId, source: 'explicit' },
    workspaces: [WORKSPACE],
    agents: [],
    spend: { kind: 'unavailable', reason: 'no_matching_session' },
    ...overrides
  }
}

function renderRow(view: TaskWorkbenchView = makeView()): void {
  render(<TaskWorkbenchDelivery view={view} layout={LAYOUT} />)
}

beforeEach(() => {
  launchModule.launchTaskWorkbenchDeliver.mockReset()
  launchModule.revealTaskWorkbenchDeliverTab.mockReset()
  toastModule.error.mockReset()
})

afterEach(cleanup)

describe('task-workbench deliver entry — which shape is on screen', () => {
  it('renders a live entry at the row’s right end when the workspace may be delivered', () => {
    renderRow()

    const entry = screen.getByTestId('task-workbench-deliver-action')
    expect(entry).toBeEnabled()
    expect(entry).toHaveTextContent('Deliver…')
    // §7.4.2: the row still carries its own facts and its fold toggle; the entry
    // is added to the row, it does not replace anything.
    expect(screen.getByTestId('task-workbench-delivery')).toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  it('renders nothing when the task has no workspace', () => {
    renderRow(
      makeView({
        workspaces: [],
        defaultWorkspace: { workspaceId: '', source: 'none' }
      })
    )

    expect(screen.queryByTestId('task-workbench-deliver-action')).toBeNull()
    // The row itself still degrades to its own notice — the entry adds no state.
    expect(screen.getByTestId('task-workbench-delivery')).toBeInTheDocument()
  })

  it('renders nothing for an archived workspace', () => {
    renderRow(
      makeView({
        workspaces: [{ ...WORKSPACE, archived: true }]
      })
    )

    expect(screen.queryByTestId('task-workbench-deliver-action')).toBeNull()
  })

  it('disables the entry for one writer and states the reason twice', () => {
    renderRow(makeView({ agents: [agentRow('working')] }))

    const entry = screen.getByTestId('task-workbench-deliver-action')
    expect(entry).toBeDisabled()
    expect(entry).toHaveAttribute('aria-describedby')
    // Rule 4: the reason is on the wrapper's `title` (a disabled Button cannot be
    // hovered) and as sr-only text the button points at.
    expect(screen.getByTitle(WORKING_REASON)).toBeInTheDocument()
    const describedBy = entry.getAttribute('aria-describedby')
    const reason = document.getElementById(describedBy ?? '')
    expect(reason).toHaveTextContent(WORKING_REASON)
    expect(reason).toHaveClass('sr-only')

    fireEvent.click(entry)
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  it('shows [ Open terminal ] for an existing DELIVER session and never launches', () => {
    launchModule.revealTaskWorkbenchDeliverTab.mockReturnValue(true)
    renderRow(makeView({ agents: [agentRow('done', 'DELIVER')] }))

    const entry = screen.getByTestId('task-workbench-deliver-action')
    expect(entry).toHaveTextContent('Open terminal')

    fireEvent.click(entry)
    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledTimes(1)
    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledWith(WORKSPACE.worktreeId)
    // A4: revealing an existing session is not a launch.
    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })
})

describe('task-workbench deliver entry — the confirmation', () => {
  it('opens the inline popover, not a dialog, with an outline submit', () => {
    renderRow()

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))

    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()
    const panel = screen.getByTestId('task-workbench-deliver-confirm')
    expect(panel.querySelector('[role="dialog"]')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('task-workbench-deliver-submit')).toHaveAttribute(
      'data-variant',
      'outline'
    )
    // The heading names what is being delivered, never just "Deliver".
    expect(panel).toHaveTextContent('acme/web-app · feat/task-431')
  })

  it('pre-fills the view’s default branch and labels it as needing confirmation', () => {
    renderRow(makeView({ targetBranchDefault: 'main' }))

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))

    expect(screen.getByTestId('task-workbench-deliver-target-branch')).toHaveValue('main')
    expect(screen.getByTestId('task-workbench-deliver-target-branch-default')).toHaveTextContent(
      'Default · needs confirmation'
    )
  })

  it('blocks submit when the view knows no default branch', () => {
    renderRow()

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))

    expect(screen.getByTestId('task-workbench-deliver-target-branch')).toHaveValue('')
    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeDisabled()
    expect(screen.getByTestId('task-workbench-deliver-target-branch-required')).toHaveTextContent(
      'Choose a target branch first.'
    )
    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
  })

  it('launches once with all three values and closes on success', () => {
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: true, tabId: 'tab-deliver' })
    renderRow(makeView({ targetBranchDefault: 'main' }))

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))
    fireEvent.change(screen.getByTestId('task-workbench-deliver-target-branch'), {
      target: { value: 'release/2026-11' }
    })
    fireEvent.click(screen.getAllByRole('radio')[2])
    fireEvent.click(screen.getByTestId('task-workbench-deliver-archive-after'))
    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))

    expect(launchModule.launchTaskWorkbenchDeliver).toHaveBeenCalledTimes(1)
    // §7.11.3: the agent hosts in the delivered workspace, and the submission
    // carries all three values — nothing is defaulted again at the launch site.
    expect(launchModule.launchTaskWorkbenchDeliver).toHaveBeenCalledWith({
      worktreeId: WORKSPACE.worktreeId,
      targetBranch: 'release/2026-11',
      integrationMode: 'squash',
      archiveAfter: true,
      source: 'task_page'
    })
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  it('never launches twice while a launch is pending', () => {
    // Why `no-agent`: it is the one failure that leaves the panel open, so the
    // second click lands on a live panel with the guard still on.
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: false, reason: 'no-agent' })
    renderRow(makeView({ targetBranchDefault: 'main' }))

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))
    const submit = screen.getByTestId('task-workbench-deliver-submit')
    fireEvent.click(submit)
    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))

    expect(launchModule.launchTaskWorkbenchDeliver).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeDisabled()
    // The failure is visible, in the existing terminal copy — no new key.
    expect(toastModule.error).toHaveBeenCalledTimes(1)
    expect(toastModule.error).toHaveBeenCalledWith(NO_AGENT_COPY)
  })

  it('reveals the existing session when the launcher reports one', () => {
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({
      ok: false,
      reason: 'already-delivering'
    })
    renderRow(makeView({ targetBranchDefault: 'main' }))

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))
    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))

    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledWith(WORKSPACE.worktreeId)
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })

  it('falls back to the confirmation when a DELIVER name has no marker tab (K4)', () => {
    // A plain `customTitle: 'DELIVER'` produces the conversation name without a
    // marker tab, so the projection says `open-terminal` and the reveal finds
    // nothing. The click must not be dead: the same confirmation opens, and the
    // launcher (which re-checks the live marker) starts the session.
    launchModule.revealTaskWorkbenchDeliverTab.mockReturnValue(false)
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: true, tabId: 'tab-deliver' })
    renderRow(makeView({ agents: [agentRow('done', 'DELIVER')], targetBranchDefault: 'main' }))

    const entry = screen.getByTestId('task-workbench-deliver-action')
    expect(entry).toHaveTextContent('Open terminal')
    fireEvent.click(entry)

    expect(launchModule.revealTaskWorkbenchDeliverTab).toHaveBeenCalledWith(WORKSPACE.worktreeId)
    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))

    expect(launchModule.launchTaskWorkbenchDeliver).toHaveBeenCalledTimes(1)
    expect(launchModule.launchTaskWorkbenchDeliver).toHaveBeenCalledWith({
      worktreeId: WORKSPACE.worktreeId,
      targetBranch: 'main',
      integrationMode: 'pr',
      archiveAfter: false,
      source: 'task_page'
    })
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
  })
  it('renders no attention row, because the projection has no such fact today', () => {
    renderRow(makeView({ targetBranchDefault: 'main' }))

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))

    expect(screen.queryByTestId('task-workbench-deliver-confirm-attention')).toBeNull()
    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeEnabled()
  })

  it('closes on cancel without launching', () => {
    renderRow(makeView({ targetBranchDefault: 'main' }))

    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))
    fireEvent.click(screen.getByTestId('task-workbench-deliver-cancel'))

    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
  })
})

describe('task-workbench deliver entry — eligibility is re-checked at submit time', () => {
  it('refuses a submit after the view turned one-writer, and states the reason', () => {
    // K1: the panel is not unmounted by a projection change — only by a view
    // that turns `none`. An agent becoming Working leaves it open, so the
    // submit itself must re-project before launching.
    launchModule.launchTaskWorkbenchDeliver.mockReturnValue({ ok: true, tabId: 'tab-deliver' })
    const { rerender } = render(
      <TaskWorkbenchDelivery view={makeView({ targetBranchDefault: 'main' })} layout={LAYOUT} />
    )
    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))
    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()

    rerender(
      <TaskWorkbenchDelivery
        view={makeView({ targetBranchDefault: 'main', agents: [agentRow('working')] })}
        layout={LAYOUT}
      />
    )
    // Still mounted, and now backed by a disabled `deliver` action.
    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))

    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
    // The frozen one-writer sentence is the visible reason (no new key).
    expect(toastModule.error).toHaveBeenCalledWith(WORKING_REASON)
  })

  it('closes without launching when the view turns archived while the panel is open', () => {
    const { rerender } = render(
      <TaskWorkbenchDelivery view={makeView({ targetBranchDefault: 'main' })} layout={LAYOUT} />
    )
    fireEvent.click(screen.getByTestId('task-workbench-deliver-action'))
    expect(screen.getByTestId('task-workbench-deliver-confirm')).toBeInTheDocument()

    rerender(
      <TaskWorkbenchDelivery
        view={makeView({
          targetBranchDefault: 'main',
          workspaces: [{ ...WORKSPACE, archived: true }]
        })}
        layout={LAYOUT}
      />
    )

    // The projection turned `none`, so both the entry and the panel are gone and
    // nothing was launched.
    expect(screen.queryByTestId('task-workbench-deliver-confirm')).toBeNull()
    expect(screen.queryByTestId('task-workbench-deliver-action')).toBeNull()
    expect(launchModule.launchTaskWorkbenchDeliver).not.toHaveBeenCalled()
  })
})

describe('task-workbench deliver entry — the row keeps its own degradation rules', () => {
  it('offers the entry from the not-read row, and still shows no commit count', () => {
    renderRow(makeView())

    // The evidence row degrades to `Not loaded` exactly as before (§7.3.1); the
    // delivery entry is the only thing added.
    expect(screen.getByTestId('task-workbench-delivery-read')).toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-delivery-commits')).toBeNull()
    expect(screen.getByTestId('task-workbench-deliver-action')).toBeEnabled()
  })

  it('keeps the evidence row’s counts untouched when evidence is present', () => {
    renderRow(
      makeView({
        delivery: {
          commits: { count: 3, lastSubject: 'fix(task-workbench): delivery action' },
          pullRequest: {
            number: 431,
            state: 'merged',
            title: 'Delivery action',
            url: 'https://github.com/acme/web-app/pull/431'
          },
          checks: { passing: 5, total: 6 },
          review: 'pending'
        }
      })
    )

    expect(screen.getByTestId('task-workbench-delivery-commits')).toHaveTextContent('3 commits')
    expect(screen.getByTestId('task-workbench-delivery-checks')).toHaveTextContent('checks 5/6')
    expect(screen.getByTestId('task-workbench-delivery-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('task-workbench-deliver-action')).toBeEnabled()
  })
})
