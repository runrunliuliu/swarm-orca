import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { VirtualItem } from '@tanstack/react-virtual'
import { i18n } from '../../../src/renderer/src/i18n/i18n'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { TaskWorkbenchPanel } from '../../../src/renderer/src/components/task-workbench/TaskWorkbenchPanel'
import { TaskWorkbenchDeliverConfirm } from '../../../src/renderer/src/components/task-workbench/task-workbench-deliver-confirm'
import { TaskPageGitHubRows } from '../../../src/renderer/src/components/task-page/github/Rows'
import { GITHUB_TASK_GRID_CLASS } from '../../../src/renderer/src/components/task-page-source-context'
import type { TaskPageComposerActionsModel } from '../../../src/renderer/src/components/use-task-page-composer-actions'
import { taskPageGitHubItemKey } from '../../../src/renderer/src/components/task-page-github-work-item-mutation-registry'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { Repo } from '../../../src/shared/repo-types'
import type { TaskWorkbenchRowActivity } from '../../../src/renderer/src/lib/task-workbench/task-workbench-row-activity'
import { renderFolderWorkspaceVirtualRow } from '../../../src/renderer/src/components/sidebar/worktree-list/rows/folder-row'
import type { FolderWorkspaceRowContext } from '../../../src/renderer/src/components/sidebar/worktree-list/rows/folder-row'
import type { FolderWorkspaceItemRow } from '../../../src/renderer/src/components/sidebar/worktree-list/listing/renderable-rows'
import { useAppStore } from '../../../src/renderer/src/store'
import type { FolderWorkspace } from '../../../src/shared/folder-workspace-types'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import {
  TASK_WORKBENCH_FIXTURES,
  getTaskWorkbenchFixture
} from '../../../src/renderer/src/components/task-workbench/task-workbench-fixtures'
import { computeTaskWorkbenchLayout } from '../../../src/renderer/src/components/task-workbench/task-workbench-layout'
import { countRowBuckets } from '../../../src/renderer/src/components/task-workbench/task-workbench-row-projection'
import type {
  TaskWorkbenchLayout,
  TaskWorkbenchView
} from '../../../src/renderer/src/components/task-workbench/task-workbench-view'
import './fixture.css'

/**
 * Rendered fixture for the task-workbench surfaces: the P1a workbench shell and
 * the sidebar draft row. One fixture and one window size per run:
 * `?fixture=<key>`.
 *
 * Why the layout comes from the viewport: P1a has no container tracking yet, so
 * the harness treats the window content area as the panel container. The run
 * driver asserts `window.innerWidth/innerHeight` equals the requested size and
 * compares the rendered `data-wb-layout-json` with its own derivation, so a
 * screenshot of the wrong size cannot pass as evidence.
 *
 * The English catalog is bundled by `i18n.ts`; `translate()` falls back to the
 * inline default, so no locale file is fetched and no network is touched.
 */

const fixtureKey = new URLSearchParams(window.location.search).get('fixture') ?? ''
const fixture = getTaskWorkbenchFixture(fixtureKey)

/**
 * The GitHub task-list row fixture (issue #27): five rows on one page, one per
 * row-activity claim plus a row with no Orca activity at all. The driver holds
 * the same titles and expected marks, so a row that loses its badge — or a row
 * that wrongly gets one — fails there instead of passing quietly.
 */
const GITHUB_ROWS_REPO: Repo = {
  id: 'repo-github-rows',
  displayName: 'acme/web-app',
  badgeColor: '#3b82f6',
  path: '/tmp/acme-web-app',
  addedAt: 1
}

const GITHUB_ROW_ITEMS: GitHubWorkItem[] = [
  githubRow(412, 'Add login auth'),
  githubRow(413, 'Retry backfill on resume'),
  githubRow(414, 'Sparse task workspace rollout'),
  githubRow(415, 'Bump docs'),
  githubRow(416, 'Unclaimed issue')
]

function githubRow(number: number, title: string): GitHubWorkItem {
  return {
    id: `issue:${number}`,
    type: 'issue',
    number,
    title,
    state: 'open',
    url: `https://github.com/acme/web-app/issues/${number}`,
    labels: [],
    updatedAt: new Date(Date.UTC(2026, 10, 18, 9, 0, 0)).toISOString(),
    author: 'octocat',
    repoId: GITHUB_ROWS_REPO.id
  }
}

/** The row claims the pure selector would return for these five rows; #416 has
 *  no bound workspace, so it is absent from the map and renders no badge. */
const GITHUB_ROW_ACTIVITY: { number: number; activity: TaskWorkbenchRowActivity }[] = [
  {
    number: 412,
    activity: {
      kind: 'working',
      dotState: 'working',
      workspaceCount: 1,
      agentCount: 1,
      taskKey: 'tracker:github:acme/web-app'
    }
  },
  {
    number: 413,
    activity: {
      kind: 'delivered',
      dotState: 'done',
      workspaceCount: 1,
      agentCount: 2,
      taskKey: 'tracker:github:acme/web-app'
    }
  },
  {
    number: 414,
    activity: {
      kind: 'workspace',
      dotState: 'idle',
      workspaceCount: 1,
      agentCount: 0,
      taskKey: 'tracker:github:acme/web-app'
    }
  },
  {
    number: 415,
    activity: {
      kind: 'needs-you',
      dotState: 'blocked',
      workspaceCount: 2,
      agentCount: 2,
      taskKey: 'tracker:github:acme/web-app'
    }
  }
]

function githubRowsModel(): TaskPageComposerActionsModel {
  const rowActivityByKey = new Map<string, TaskWorkbenchRowActivity>()
  for (const entry of GITHUB_ROW_ACTIVITY) {
    rowActivityByKey.set(taskPageGitHubItemKey(GITHUB_ROWS_REPO.id, `issue:${entry.number}`), entry.activity)
  }
  // The rows read a dozen model fields and forward the rest; the other page
  // stages (pagination, search, dialogs) never run in this fixture.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies every field `TaskPageGitHubRows` reads; the rest of the page model is not reached by the row component.
  return {
    repoMap: new Map([[GITHUB_ROWS_REPO.id, GITHUB_ROWS_REPO]]),
    allWorktrees: [],
    selectedRepos: [GITHUB_ROWS_REPO.id],
    openGitHubDetailPage: () => {},
    githubWorkItemMutation: {
      isIntentPending: () => false,
      softHiddenItemKeys: new Set<string>()
    },
    filteredWorkItems: GITHUB_ROW_ITEMS,
    showGitHubTaskSkeletons: false,
    showPRManagementColumns: false,
    githubTaskGridClass: GITHUB_TASK_GRID_CLASS,
    ensurePRChecksLoaded: () => {},
    handleUseWorkItem: () => {},
    handleOpenOrUseGitHubWorkItem: () => {},
    rowActivityByKey
  } as unknown as TaskPageComposerActionsModel
}

/** The sidebar row fixture's linked issue; `run.mjs`'s derive() holds the same number. */
const LINKED_ISSUE_NUMBER = 412

const PROJECT_GROUP: ProjectGroup = {
  id: 'project-group-drafts',
  name: 'Draft tasks',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function makeFolderWorkspace(
  id: string,
  name: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id,
    projectGroupId: PROJECT_GROUP.id,
    name,
    folderPath: `/tmp/task-drafts/${id}`,
    linkedTask: null,
    taskDraft: true,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

// Duplicated in `run.mjs`'s derive(): the driver owns the expected badge/link per
// row, so a fixture edit that drops one fails there instead of passing quietly.
const SIDEBAR_ROWS: FolderWorkspaceItemRow[] = [
  {
    type: 'folder-workspace',
    key: 'folder-workspace:draft-linked',
    projectGroup: PROJECT_GROUP,
    depth: 0,
    groupDepth: 0,
    folderWorkspace: makeFolderWorkspace('draft-linked', 'add-login-retry', {
      linkedTask: {
        provider: 'github',
        type: 'issue',
        number: LINKED_ISSUE_NUMBER,
        title: 'Add login retry',
        url: `https://github.com/acme/widgets/issues/${LINKED_ISSUE_NUMBER}`
      }
    })
  },
  {
    type: 'folder-workspace',
    key: 'folder-workspace:draft-unlinked',
    projectGroup: PROJECT_GROUP,
    depth: 0,
    groupDepth: 0,
    folderWorkspace: makeFolderWorkspace('draft-unlinked', 'trim-copy')
  },
  {
    type: 'folder-workspace',
    key: 'folder-workspace:plain-folder',
    projectGroup: PROJECT_GROUP,
    depth: 0,
    groupDepth: 0,
    folderWorkspace: makeFolderWorkspace('plain-folder', 'release-notes', {
      taskDraft: undefined
    })
  }
]

const SIDEBAR_ROW_HEIGHT = 72

/** No-op row context: the fixture proves the marker line, not selection, drag,
 *  PR decoration or path status. `settings: null` is the store's own default. */
const SIDEBAR_ROW_CONTEXT: FolderWorkspaceRowContext = {
  groupBy: 'none',
  newCardStyle: false,
  settings: null,
  activeWorktreeId: null,
  currentWorktreeId: null,
  selectedWorktreeIds: new Set<string>(),
  repoMap: new Map(),
  worktreeMap: new Map(),
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  prCache: null,
  hostedReviewCache: null,
  getCachedFolderWorkspacePathStatus: () => null,
  onSelectionGesture: () => false,
  onContextMenuSelect: () => [],
  onImmediateActivate: () => {},
  onRowClickCapture: () => {},
  onRowPointerDown: () => {}
}

// Why: the marker line reads the renderer-only removal marker from the real
// store; an empty map is the "no linked task read came back missing" state.
useAppStore.setState({ taskDraftLinkMissing: {} })

/** The production folder-workspace row (the narrowest component that renders
 *  `folder-row.tsx`'s marker), three rows in a real virtual-list container:
 *  a linked draft, an unlinked draft and a normal folder workspace. */
function SidebarDraftRowFixture(): React.JSX.Element {
  return (
    <main
      data-testid="sidebar-fixture-root"
      className="min-h-screen bg-background p-4 text-foreground"
    >
      <div
        data-testid="sidebar-fixture-list"
        className="relative w-[380px] rounded-md border border-border/50 bg-background"
        style={{ height: SIDEBAR_ROWS.length * SIDEBAR_ROW_HEIGHT }}
      >
        {SIDEBAR_ROWS.map((row, index) => {
          const vItem: VirtualItem = {
            key: row.key,
            index,
            start: index * SIDEBAR_ROW_HEIGHT,
            end: (index + 1) * SIDEBAR_ROW_HEIGHT,
            size: SIDEBAR_ROW_HEIGHT,
            lane: 0
          }
          return renderFolderWorkspaceVirtualRow({
            ctx: SIDEBAR_ROW_CONTEXT,
            row,
            vItem,
            measureVirtualRowElement: () => {}
          })
        })}
      </div>
    </main>
  )
}

function GitHubTaskRowsFixture(): React.JSX.Element {
  return (
    <main
      data-testid="github-task-rows-fixture-root"
      className="min-h-screen bg-background p-4 text-foreground"
    >
      <div
        data-testid="github-task-rows-fixture-list"
        className="overflow-hidden rounded-md border border-border/50 bg-background"
      >
        <TaskPageGitHubRows model={githubRowsModel()} />
      </div>
    </main>
  )
}

/**
 * §7.12's delivery scope, rendered on its own.
 *
 * Why a separate fixture: the panel only mounts after a click on the Delivery
 * row, and this harness deliberately has no click path. Rendering the production
 * component directly is what makes the new confirm surface checkable by pixels
 * and by testid; the two hosts that mount it are covered by vitest.
 */
function DeliverConfirmFixture(): React.JSX.Element {
  return (
    <main
      data-testid="deliver-confirm-fixture-root"
      className="min-h-screen bg-background p-10 text-foreground"
    >
      <TaskWorkbenchDeliverConfirm
        heading="acme/web-app · feat/task-431"
        defaultTargetBranch="main"
        issueNumber={412}
        onSubmit={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
      />
    </main>
  )
}

function FixtureError({ fixtureKey }: { fixtureKey: string }): React.JSX.Element {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div
        data-testid="task-workbench-fixture-error"
        role="alert"
        className="rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        Unknown task-workbench fixture: <code>{fixtureKey || '(missing)'}</code>. Known fixtures:{' '}
        <code>
          {Object.keys(TASK_WORKBENCH_FIXTURES)
            .concat(['d5_sidebar_draft_row', 'd6_github_task_rows', 'deliver_confirm'])
            .join(', ')}
        </code>
      </div>
    </main>
  )
}

function Fixture({ view }: { view: TaskWorkbenchView }): React.JSX.Element {
  const counts = {
    workspaces: view.workspaces.length,
    ...countRowBuckets(view.agents)
  }
  const layout: TaskWorkbenchLayout = computeTaskWorkbenchLayout({
    containerWidth: window.innerWidth,
    containerHeight: window.innerHeight,
    counts,
    mode: 'static'
  })
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <TaskWorkbenchPanel view={view} layout={layout} />
    </main>
  )
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(
  <I18nextProvider i18n={i18n}>
    <TooltipProvider>
      {fixture ? (
        <Fixture view={fixture.view} />
      ) : fixtureKey === 'd5_sidebar_draft_row' ? (
        <SidebarDraftRowFixture />
      ) : fixtureKey === 'd6_github_task_rows' ? (
        <GitHubTaskRowsFixture />
      ) : fixtureKey === 'deliver_confirm' ? (
        <DeliverConfirmFixture />
      ) : (
        <FixtureError fixtureKey={fixtureKey} />
      )}
    </TooltipProvider>
  </I18nextProvider>
)
