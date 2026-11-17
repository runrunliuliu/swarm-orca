import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { VirtualItem } from '@tanstack/react-virtual'
import { i18n } from '../../../src/renderer/src/i18n/i18n'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { TaskWorkbenchPanel } from '../../../src/renderer/src/components/task-workbench/TaskWorkbenchPanel'
import { TASK_PAGE_COLUMN_CLASS } from '../../../src/renderer/src/components/task-page/Frame'
import { PaginationBar } from '../../../src/renderer/src/components/task-page/PaginationBar'
import { TaskDock } from '../../../src/renderer/src/components/task-page/TaskDock'
import type {
  TaskDockModel,
  TaskDockModelOption,
  TaskDockTranscriptLine
} from '../../../src/renderer/src/components/task-page/TaskDock'
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
 * Rendered fixture for the task-workbench surfaces: the P1a workbench shell, the
 * Tasks list-page agent dock and the sidebar draft row. One fixture and one
 * window size per run: `?fixture=<key>`.
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

const DOCK_FIXTURES: Record<string, 'collapsed' | 'expanded'> = {
  d1_dock_collapsed: 'collapsed',
  d2_dock_expanded: 'expanded'
}
const dockState = DOCK_FIXTURES[fixtureKey]

// The typed instruction and the model list are deliberately duplicated in
// `run.mjs`'s derive(): the driver retypes the instruction and picks a model, so
// a fixture edit that changes either fails there instead of quietly weakening
// the assertions.
const DOCK_TYPED_INSTRUCTION = 'Fix the flaky login test'
const DOCK_MODEL_OPTIONS: readonly TaskDockModelOption[] = [
  { id: 'claude-opus-4', label: 'Opus 4' },
  { id: 'claude-sonnet-4', label: 'Sonnet 4' }
]

// Duplicated in `run.mjs`'s derive() like the other dock pins: the driver owns the expected tail,
// so a fixture edit that drops a line fails there instead of passing quietly.
const DOCK_TRANSCRIPT: readonly TaskDockTranscriptLine[] = [
  { text: 'Draft workspace ready: /tmp/task-drafts/add-login-retry', tone: 'meta' },
  { text: '> Fix the flaky login test', tone: 'user' },
  { text: 'Reading the failing test before I change anything.', tone: 'agent' }
]

// Duplicated in `run.mjs`'s derive() for the same reason as the dock pins.
const LINKED_ISSUE_NUMBER = 412

/** The dock is the one interactive part of the Tasks list page, and it is the
 *  only thing this fixture mounts: a column that mirrors `Frame.tsx` (the
 *  padded class is imported, not retyped) around a real `PaginationBar`, with
 *  local state standing in for the dock action hook. */
function DockFixture({ state }: { state: 'collapsed' | 'expanded' }): React.JSX.Element {
  const [instruction, setInstruction] = React.useState(
    state === 'expanded' ? DOCK_TYPED_INSTRUCTION : ''
  )
  const [expanded, setExpanded] = React.useState(state === 'expanded')
  const [modelId, setModelId] = React.useState('')
  const [submitting] = React.useState(false)
  const [targetLabel] = React.useState<string | null>('github · acme/widgets')
  const [errorMessage] = React.useState<string | null>(null)
  const [submits, setSubmits] = React.useState(0)
  const [lastInstruction, setLastInstruction] = React.useState('')
  const [lastModel, setLastModel] = React.useState('')
  const transcript = state === 'expanded' ? DOCK_TRANSCRIPT : []

  const model: TaskDockModel = {
    instruction,
    expanded,
    targetLabel,
    model: modelId,
    modelOptions: DOCK_MODEL_OPTIONS,
    transcript,
    transcriptStatus: transcript.length > 0 ? 'live' : 'none',
    submitting,
    errorMessage,
    onInstructionChange: setInstruction,
    onModelChange: setModelId,
    onExpandedChange: setExpanded,
    onSubmit: () => {
      setSubmits((count) => count + 1)
      setLastInstruction(instruction)
      setLastModel(modelId)
    }
  }

  return (
    <main
      data-testid="dock-fixture-root"
      data-dock-submits={submits}
      data-dock-last-instruction={lastInstruction}
      data-dock-last-model={lastModel}
      data-dock-instruction={instruction}
      data-dock-model={modelId}
      data-dock-expanded={String(expanded)}
      className="flex h-screen flex-col bg-background p-4 text-foreground"
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Why: same shape as Frame.tsx — one padded column holding the list card and the dock,
            so "the dock is outside the card" is tested against the real layout classes. */}
        <div data-testid="dock-fixture-column" className={TASK_PAGE_COLUMN_CLASS}>
          <div
            data-testid="dock-fixture-card"
            className="flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm"
          >
            <div
              data-testid="dock-fixture-card-scroll"
              className="min-h-0 flex-initial overflow-auto scrollbar-sleek scrollbar-sleek-lg"
              style={{ scrollbarGutter: 'stable' }}
            >
              {Array.from({ length: 40 }, (_, index) => (
                <div
                  key={index}
                  className="flex h-10 items-center border-b border-border/40 px-4 text-sm text-muted-foreground"
                >
                  {`Synthetic task ${index + 1}`}
                </div>
              ))}
            </div>
            <div data-testid="dock-fixture-card-footer">
              <PaginationBar
                currentPage={0}
                totalPages={5}
                loadingTarget={null}
                onPageChange={() => {}}
              />
            </div>
          </div>
          <TaskDock model={model} />
        </div>
      </div>
    </main>
  )
}

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
            .concat(Object.keys(DOCK_FIXTURES), ['d5_sidebar_draft_row'])
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
      ) : dockState ? (
        <DockFixture state={dockState} />
      ) : fixtureKey === 'd5_sidebar_draft_row' ? (
        <SidebarDraftRowFixture />
      ) : (
        <FixtureError fixtureKey={fixtureKey} />
      )}
    </TooltipProvider>
  </I18nextProvider>
)
