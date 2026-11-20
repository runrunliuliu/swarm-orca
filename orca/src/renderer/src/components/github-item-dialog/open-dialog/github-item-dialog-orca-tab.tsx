import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bot } from 'lucide-react'
import { TabsTrigger } from '@/components/ui/tabs'
import { TaskWorkbenchPanel } from '@/components/task-workbench/TaskWorkbenchPanel'
import { computeTaskWorkbenchLayout } from '@/components/task-workbench/task-workbench-layout'
import { countRowBuckets } from '@/components/task-workbench/task-workbench-row-projection'
import type {
  TaskWorkbenchLayout,
  TaskWorkbenchView
} from '@/components/task-workbench/task-workbench-view'
import { useTaskWorkbenchView } from '@/hooks/use-task-workbench-view'
import { useTaskWorkbenchDeliverArchive } from '@/hooks/use-task-workbench-deliver-archive'
import { translate } from '@/i18n/i18n'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

/**
 * The real `Orca` tab entry (README §7.4, M1): the existing item detail gains a
 * task aggregate view. The shell keeps receiving a `view` prop; this module is
 * the detail surface's only edge to the store-reading hook.
 */

function orcaTabKeys(key: string): string {
  return `auto.components.GitHubItemDialogOrcaTab.${key}`
}

const INITIAL_CONTAINER_SIZE = { width: 0, height: 0 }

/** Live mode: measure the tab body and feed the same pure decision function the
 *  P1a harness uses. The first render has no observation yet, so it starts at
 *  zero (the function is total) instead of guessing or rendering NaN. */
function useLiveLayout(
  view: TaskWorkbenchView,
  containerRef: React.RefObject<HTMLDivElement | null>
): TaskWorkbenchLayout {
  const [size, setSize] = useState(INITIAL_CONTAINER_SIZE)

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }
      const width = entry.contentRect.width
      const height = entry.contentRect.height
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  const counts = useMemo(
    () => ({ ...countRowBuckets(view.agents), workspaces: view.workspaces.length }),
    [view.agents, view.workspaces.length]
  )

  return useMemo(
    () =>
      computeTaskWorkbenchLayout({
        containerWidth: size.width,
        containerHeight: size.height,
        counts,
        mode: 'live'
      }),
    [counts, size.height, size.width]
  )
}

function OrcaTabPanel({ view }: { view: TaskWorkbenchView }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const layout = useLiveLayout(view, containerRef)

  return (
    <div
      ref={containerRef}
      data-testid="task-workbench-tab"
      className="h-full min-h-0 overflow-y-auto scrollbar-sleek p-4"
    >
      <TaskWorkbenchPanel view={view} layout={layout} />
    </div>
  )
}

export function OrcaTabTrigger({
  className
}: {
  className?: string
}): React.JSX.Element {
  return (
    <TabsTrigger value="orca" className={className}>
      <Bot className="size-3.5" />
      {translate(orcaTabKeys('tabLabel'), 'Orca')}
    </TabsTrigger>
  )
}

export function OrcaTabContent({
  repoId,
  number,
  itemType,
  title,
  tracker,
  sourceContext
}: {
  repoId: string | null
  number: number
  itemType: 'issue' | 'pr'
  title: string
  tracker?: { state: 'open' | 'closed'; url: string }
  sourceContext?: TaskSourceContext | null
}): React.JSX.Element {
  // §7.12 A3: the issue fact and the `关闭 issue` tick need the page's own
  // number. It is handed over only for an issue page — this dialog's tracker on
  // a PR page describes the PR, not a deliverable issue.
  const trackedItem =
    tracker && itemType === 'issue' ? { ...tracker, number } : tracker
  const view = useTaskWorkbenchView({
    repoId,
    number,
    itemType,
    title,
    tracker: trackedItem,
    taskSourceContext: sourceContext
  })
  // §7.12 D2/A10: the archive the operator ticked happens here, once, after the
  // completion fact is observable. The agent never archives itself (§7.11.3
  // rule 8), so this is the only writer for that intent.
  useTaskWorkbenchDeliverArchive(view)

  if (!view) {
    return (
      <div data-testid="task-workbench-tab" className="px-4 py-6 text-[12px] text-muted-foreground">
        {translate(
          orcaTabKeys('empty'),
          'No workspace or tracker identity is linked to this item yet.'
        )}
      </div>
    )
  }

  return <OrcaTabPanel view={view} />
}
