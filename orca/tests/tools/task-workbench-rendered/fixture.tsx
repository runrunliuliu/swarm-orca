import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { VirtualItem } from '@tanstack/react-virtual'
import { i18n } from '../../../src/renderer/src/i18n/i18n'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { TaskWorkbenchPanel } from '../../../src/renderer/src/components/task-workbench/TaskWorkbenchPanel'
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
            .concat(['d5_sidebar_draft_row'])
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
      ) : (
        <FixtureError fixtureKey={fixtureKey} />
      )}
    </TooltipProvider>
  </I18nextProvider>
)
