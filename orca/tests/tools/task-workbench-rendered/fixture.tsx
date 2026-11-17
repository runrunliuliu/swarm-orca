import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { i18n } from '../../../src/renderer/src/i18n/i18n'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { TaskWorkbenchPanel } from '../../../src/renderer/src/components/task-workbench/TaskWorkbenchPanel'
import { TASK_PAGE_COLUMN_CLASS } from '../../../src/renderer/src/components/task-page/Frame'
import { PaginationBar } from '../../../src/renderer/src/components/task-page/PaginationBar'
import { TaskDock } from '../../../src/renderer/src/components/task-page/TaskDock'
import type { TaskDockModel } from '../../../src/renderer/src/components/task-page/TaskDock'
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
 * the P2a Tasks list-page dock. One fixture and one window size per run:
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

const DOCK_FIXTURES: Record<string, 'collapsed' | 'expanded'> = {
  d1_dock_collapsed: 'collapsed',
  d2_dock_expanded: 'expanded'
}
const dockState = DOCK_FIXTURES[fixtureKey]

// The typed instruction is deliberately duplicated in `run.mjs`'s derive(): the
// driver retypes it, so a fixture edit that changes it fails there instead of
// quietly weakening the keyboard assertion.
const DOCK_TYPED_INSTRUCTION = 'Fix the flaky login test'

/** The dock is the one interactive part of the Tasks list page, and it is the
 *  only thing this fixture mounts: a column that mirrors `Frame.tsx` (the
 *  padded class is imported, not retyped) around a real `PaginationBar`, with
 *  local state standing in for the dock action hook. */
function DockFixture({ state }: { state: 'collapsed' | 'expanded' }): React.JSX.Element {
  const [instruction, setInstruction] = React.useState(
    state === 'expanded' ? DOCK_TYPED_INSTRUCTION : ''
  )
  const [expanded, setExpanded] = React.useState(state === 'expanded')
  const [submitting] = React.useState(false)
  const [targetLabel] = React.useState<string | null>('github · acme/widgets')
  const [errorMessage] = React.useState<string | null>(null)
  const [submits, setSubmits] = React.useState(0)
  const [lastInstruction, setLastInstruction] = React.useState('')

  const model: TaskDockModel = {
    instruction,
    expanded,
    targetLabel,
    submitting,
    errorMessage,
    onInstructionChange: setInstruction,
    onExpandedChange: setExpanded,
    onSubmit: () => {
      setSubmits((count) => count + 1)
      setLastInstruction(instruction)
    }
  }

  return (
    <main
      data-testid="dock-fixture-root"
      data-dock-submits={submits}
      data-dock-last-instruction={lastInstruction}
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
          {Object.keys(TASK_WORKBENCH_FIXTURES).concat(Object.keys(DOCK_FIXTURES)).join(', ')}
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
      ) : (
        <FixtureError fixtureKey={fixtureKey} />
      )}
    </TooltipProvider>
  </I18nextProvider>
)
