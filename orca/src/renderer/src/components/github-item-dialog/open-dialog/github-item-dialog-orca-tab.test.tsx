// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { normalizeItemDialogTab } from '@/components/github/github-work-item-identity'
import { i18n } from '@/i18n/i18n'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type {
  TaskWorkbenchView,
  TaskWorkbenchWorkspace
} from '@/components/task-workbench/task-workbench-view'
import { OrcaTabContent, OrcaTabTrigger } from './github-item-dialog-orca-tab'

const useTaskWorkbenchViewMock = vi.hoisted(() => vi.fn())
const panelMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-task-workbench-view', () => ({
  useTaskWorkbenchView: useTaskWorkbenchViewMock
}))

// Why the panel is mocked: mounting the real panel pulls `TaskWorkbenchAgentRow`
// -> `AgentKanbanCard` -> `lib/agent-catalog.tsx`, which imports
// `resources/openclaude-logo.png`. The sparse task checkout does not carry
// `orca/resources`, so that module graph cannot load in the unit-test runner at
// all (the rendered harness stubs the asset; this config does not). This file
// therefore asserts the tab's wiring — hook arguments in, panel props out — and
// the panel's own rendering for both identity shapes is asserted by the harness
// on the F1 (tracker) and F6 (workspace-only) fixtures.
vi.mock('@/components/task-workbench/TaskWorkbenchPanel', () => ({
  TaskWorkbenchPanel: (props: { view: TaskWorkbenchView }) => {
    panelMock(props)
    return <div data-testid="task-workbench-panel" />
  }
}))

const SOURCE_CONTEXT: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-web-app',
  hostId: LOCAL_EXECUTION_HOST_ID
}

const WORKSPACE: TaskWorkbenchWorkspace = {
  repoId: 'repo-web-app',
  worktreeId: 'wt-feature-add-login',
  repoName: 'web-app',
  worktreeName: 'feature/add-login',
  hostKind: 'local',
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  workspaceKind: 'worktree'
}

const TRACKER_VIEW: TaskWorkbenchView = {
  identity: { kind: 'tracker', provider: { provider: 'github', owner: 'acme', repo: 'web-app' } },
  title: 'Add login auth',
  tracker: { state: 'open', url: 'https://github.com/acme/web-app/issues/412' },
  defaultWorkspace: { workspaceId: WORKSPACE.worktreeId, source: 'explicit' },
  agents: [],
  workspaces: [WORKSPACE],
  spend: { kind: 'unavailable', reason: 'no_matching_session' }
}

const WORKSPACE_VIEW: TaskWorkbenchView = {
  identity: { kind: 'workspace', primaryWorktreeId: WORKSPACE.worktreeId },
  title: 'Local-only task',
  defaultWorkspace: { workspaceId: WORKSPACE.worktreeId, source: 'explicit' },
  agents: [],
  workspaces: [WORKSPACE],
  spend: { kind: 'unavailable', reason: 'no_matching_session' }
}

const ISSUE_ITEM: GitHubWorkItem = {
  id: 'issue-412',
  type: 'issue',
  number: 412,
  title: 'Add login auth',
  state: 'open',
  url: 'https://github.com/acme/web-app/issues/412',
  labels: [],
  updatedAt: '2026-11-17T00:00:00Z',
  author: 'octocat',
  repoId: 'repo-web-app'
}

const PR_ITEM: GitHubWorkItem = {
  ...ISSUE_ITEM,
  id: 'pr-431',
  type: 'pr',
  number: 431,
  url: 'https://github.com/acme/web-app/pull/431'
}

function renderOrcaTab(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <Tabs defaultValue="orca">
          <TabsList>
            <OrcaTabTrigger />
          </TabsList>
          <TabsContent value="orca">
            <OrcaTabContent
              repoId="repo-web-app"
              number={412}
              itemType="issue"
              title="Add login auth"
              tracker={{ state: 'open', url: 'https://github.com/acme/web-app/issues/412' }}
              sourceContext={SOURCE_CONTEXT}
            />
          </TabsContent>
        </Tabs>
      </TooltipProvider>
    </I18nextProvider>
  )
}

beforeEach(async () => {
  useTaskWorkbenchViewMock.mockReset()
  panelMock.mockReset()
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

describe('GitHub item dialog Orca tab', () => {
  it('renders the trigger and the panel for a tracker-backed task', () => {
    useTaskWorkbenchViewMock.mockReturnValue(TRACKER_VIEW)

    renderOrcaTab()

    expect(screen.getByRole('tab', { name: 'Orca' })).not.toBeNull()
    expect(screen.getByTestId('task-workbench-tab')).not.toBeNull()
    expect(screen.getByTestId('task-workbench-panel')).not.toBeNull()
    expect(useTaskWorkbenchViewMock).toHaveBeenCalledWith({
      repoId: 'repo-web-app',
      number: 412,
      itemType: 'issue',
      title: 'Add login auth',
      // §7.12 A3: the issue page hands its own number to the view, so the
      // delivery row can name the issue it would close.
      tracker: {
        state: 'open',
        url: 'https://github.com/acme/web-app/issues/412',
        number: 412
      },
      taskSourceContext: SOURCE_CONTEXT
    })
  })

  it('does not hand a PR page’s number over as an issue number', () => {
    useTaskWorkbenchViewMock.mockReturnValue(TRACKER_VIEW)

    render(
      <I18nextProvider i18n={i18n}>
        <Tabs defaultValue="orca">
          <TabsList>
            <OrcaTabTrigger />
          </TabsList>
          <TabsContent value="orca">
            <OrcaTabContent
              repoId="repo-web-app"
              number={431}
              itemType="pr"
              title="Deliver login"
              tracker={{ state: 'open', url: 'https://github.com/acme/web-app/pull/431' }}
              sourceContext={SOURCE_CONTEXT}
            />
          </TabsContent>
        </Tabs>
      </I18nextProvider>
    )

    // The tracker on a PR page describes the PR; an issue fact there would name
    // the wrong item, so the number stays absent (§7.12 A3).
    expect(useTaskWorkbenchViewMock.mock.calls[0][0].tracker).toEqual({
      state: 'open',
      url: 'https://github.com/acme/web-app/pull/431'
    })
  })

  it('passes the workspace-only view through to the panel', () => {
    useTaskWorkbenchViewMock.mockReturnValue(WORKSPACE_VIEW)

    renderOrcaTab()

    expect(screen.getByTestId('task-workbench-panel')).not.toBeNull()
    expect(panelMock).toHaveBeenCalledTimes(1)
    expect(panelMock.mock.calls[0][0].view.identity).toEqual({
      kind: 'workspace',
      primaryWorktreeId: 'wt-feature-add-login'
    })
  })

  it('renders the empty notice and no panel when the hook returns null', () => {
    useTaskWorkbenchViewMock.mockReturnValue(null)

    renderOrcaTab()

    expect(screen.queryByTestId('task-workbench-panel')).toBeNull()
    expect(screen.getByTestId('task-workbench-tab').textContent).toContain(
      'No workspace or tracker identity is linked to this item yet.'
    )
  })

  it('preserves the Orca tab for issues and pull requests', () => {
    expect(normalizeItemDialogTab(ISSUE_ITEM, 'orca')).toBe('orca')
    expect(normalizeItemDialogTab(PR_ITEM, 'orca')).toBe('orca')
    // Existing behaviour for the other values stays: non-PR tabs collapse to conversation.
    expect(normalizeItemDialogTab(ISSUE_ITEM, 'files')).toBe('conversation')
    expect(normalizeItemDialogTab(PR_ITEM, 'files')).toBe('files')
  })
})
