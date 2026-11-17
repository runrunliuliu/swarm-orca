import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { i18n } from '../../../src/renderer/src/i18n/i18n'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { TaskWorkbenchPanel } from '../../../src/renderer/src/components/task-workbench/TaskWorkbenchPanel'
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
 * Rendered fixture for the P1a workbench shell. One fixture and one window size
 * per run: `?fixture=<key>`.
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

function FixtureError({ fixtureKey }: { fixtureKey: string }): React.JSX.Element {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div
        data-testid="task-workbench-fixture-error"
        role="alert"
        className="rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        Unknown task-workbench fixture: <code>{fixtureKey || '(missing)'}</code>. Known fixtures:{' '}
        <code>{Object.keys(TASK_WORKBENCH_FIXTURES).join(', ')}</code>
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
      {fixture ? <Fixture view={fixture.view} /> : <FixtureError fixtureKey={fixtureKey} />}
    </TooltipProvider>
  </I18nextProvider>
)
