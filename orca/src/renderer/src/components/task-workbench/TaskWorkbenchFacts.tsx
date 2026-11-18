import React from 'react'
import { TaskWorkbenchDelivery } from './TaskWorkbenchDelivery'
import { TaskWorkbenchSpend } from './TaskWorkbenchSpend'
import type { TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

/**
 * The facts strip: task-level usage and delivery read as two rows of one surface
 * (README §7.4.2), not two cards with a dashed warning each.
 *
 * Why they share a surface: both answer "what do we know about this task from
 * outside the agents", and both degrade to a labelled absence. Two cards made the
 * absence look like an error twice; one strip says it once, in one shape, and
 * leaves the screen's only filled primary button to the page header.
 *
 * The sections keep their own files: `layout.spend` and `layout.delivery` degrade
 * independently (§7.3.1 sacrifices Delivery first, then Spend detail), and this
 * component only decides that they sit in the same frame.
 */

export function TaskWorkbenchFacts({
  view,
  layout
}: {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}): React.JSX.Element {
  return (
    <div
      data-testid="task-workbench-facts"
      className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg bg-card/40 ring-1 ring-inset ring-border/60"
    >
      <TaskWorkbenchSpend view={view} layout={layout} />
      <TaskWorkbenchDelivery view={view} layout={layout} />
    </div>
  )
}
