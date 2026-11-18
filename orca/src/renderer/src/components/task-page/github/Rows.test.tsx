import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { GITHUB_TASK_GRID_CLASS } from '../../task-page-source-context'
import type { TaskWorkbenchRowActivity } from '@/lib/task-workbench/task-workbench-row-activity'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageGitHubRows } from './Rows'

/**
 * The list-row half of issue #27: the badge appears beside a row that has Orca
 * activity, and the tracker state pill still reports the provider's own state
 * (`Open`) — the two facts stay parallel, the badge never restates or replaces
 * the pill.
 *
 * Rendered through `renderToStaticMarkup` with a stub model instead of mounting
 * the page: the row only reads the model it is handed, so a hand-built model is
 * the honest unit here and keeps the store, RPC and pagination out of the test.
 */

function repo(): Repo {
  return {
    id: 'repo-1',
    displayName: 'acme/web-app',
    badgeColor: '#123456',
    path: '/tmp/acme-web-app',
    kind: 'git',
    addedAt: 1
  }
}

function issue(): GitHubWorkItem {
  return {
    id: 'issue:12',
    type: 'issue',
    number: 12,
    title: 'Add login auth',
    state: 'open',
    url: 'https://github.com/acme/web-app/issues/12',
    labels: [],
    updatedAt: new Date(0).toISOString(),
    author: 'octocat',
    repoId: 'repo-1'
  }
}

function model(
  rowActivityByKey: ReadonlyMap<string, TaskWorkbenchRowActivity>
): TaskPageComposerActionsModel {
  const acme = repo()
  // The row component reads a dozen of the model's fields and forwards the rest
  // untouched, so a hand-built stub is the honest unit double here; listing the
  // other ~40 stages would test the page, not the row.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies every field `TaskPageGitHubRows` reads; the page's other stages are unrelated to the row and are not reached.
  return {
    repoMap: new Map([[acme.id, acme]]),
    allWorktrees: [],
    selectedRepos: [acme.id],
    openGitHubDetailPage: vi.fn(),
    githubWorkItemMutation: {
      isIntentPending: () => false,
      softHiddenItemKeys: new Set<string>()
    },
    filteredWorkItems: [issue()],
    showGitHubTaskSkeletons: false,
    showPRManagementColumns: false,
    githubTaskGridClass: GITHUB_TASK_GRID_CLASS,
    ensurePRChecksLoaded: vi.fn(),
    handleUseWorkItem: vi.fn(),
    handleOpenOrUseGitHubWorkItem: vi.fn(),
    rowActivityByKey
  } as unknown as TaskPageComposerActionsModel
}

function renderRow(rowActivityByKey: ReadonlyMap<string, TaskWorkbenchRowActivity>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TaskPageGitHubRows model={model(rowActivityByKey)} />
    </TooltipProvider>
  )
}

describe('github task rows — Orca activity badge', () => {
  it('renders no badge when the row has no Orca activity, and keeps the pin on the tracker state', () => {
    const html = renderRow(new Map())
    expect(html).not.toContain('data-row-activity')
    expect(html).toContain('Open')
  })

  it('renders the badge once the row has a bound workspace with an agent', () => {
    const html = renderRow(
      new Map([
        [
          'repo-1\u0000issue:12',
          {
            kind: 'working',
            dotState: 'working',
            workspaceCount: 1,
            agentCount: 1,
            taskKey: 'tracker:github:acme/web-app'
          }
        ]
      ])
    )
    expect(html).toContain('data-row-activity="working"')
    expect(html).toContain('Working')
    // The provider's own state is untouched: the badge is additive.
    expect(html).toContain('Open')
  })

  it('renders the gray Workspace mark for a workspace with no agent', () => {
    const html = renderRow(
      new Map([
        [
          'repo-1\u0000issue:12',
          {
            kind: 'workspace',
            dotState: 'idle',
            workspaceCount: 1,
            agentCount: 0,
            taskKey: 'tracker:github:acme/web-app'
          }
        ]
      ])
    )
    expect(html).toContain('data-row-activity="workspace"')
    expect(html).toContain('Workspace')
  })
})
