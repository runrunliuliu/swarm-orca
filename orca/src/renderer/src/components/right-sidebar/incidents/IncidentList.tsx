// The incident list (§12, M7-B): the panel's main surface.
//
// Presentational on purpose. It receives the rows the panel already filtered, reports which row was
// opened, and owns only focus. Every interpretation ("how many are untriaged", "may the count be
// incomplete", "may I confirm this") belongs to the host or to the panel's model modules; a list that
// starts reasoning about status is how the renderer grows a second triage policy.
//
// Accessibility: the rows are buttons, so Tab reaches them and Enter/Space open one. A roving tabindex
// plus Arrow/Home/End keeps the whole list to a single tab stop once the reader is inside it, which is
// the list convention this repository already uses elsewhere. The column header row is visual only
// (`aria-hidden`): each row button carries a complete accessible label instead, because a six-column
// header announced before every row is noise in a screen reader.

import React, { useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type {
  IncidentListItemDto,
  IncidentStatusDto
} from '../../../../../shared/incident-api-types'
import { incidentClassLabel, incidentStatusLabel } from './incident-labels'
import { resolveIncidentListNavigation } from './incident-list-navigation'

const STATUS_TONE: Record<IncidentStatusDto, string> = {
  untriaged: 'border-destructive/40 text-destructive',
  confirmed: 'border-border text-foreground',
  watch: 'border-status-warning-border text-status-warning',
  needs_archive: 'border-status-warning-border text-status-warning',
  acceptance_pending: 'border-status-warning-border text-status-warning',
  duplicate: 'border-border text-muted-foreground',
  invalid: 'border-border text-muted-foreground',
  closed: 'border-border text-muted-foreground'
}

function agentCell(item: IncidentListItemDto): { text: string; title: string } {
  if (item.agentSessionId === null) {
    return {
      text: '—',
      title: translate('auto.components.right.sidebar.incidents.IncidentList.09745be62a',
        'No agent session binding: this fact was recorded at pane or host level.'
      )
    }
  }
  return {
    text: item.agentSessionId.slice(0, 8),
    title: item.agentSessionId
  }
}

export function IncidentRow({
  item,
  selected,
  tabIndex,
  now,
  onOpen,
  onFocus,
  rowRef
}: {
  item: IncidentListItemDto
  selected: boolean
  tabIndex: number
  now: number
  onOpen: (item: IncidentListItemDto) => void
  onFocus: () => void
  rowRef: (element: HTMLButtonElement | null) => void
}): React.JSX.Element {
  const agent = agentCell(item)
  const statusLabel = incidentStatusLabel(item.effectiveStatus)
  const classLabel = incidentClassLabel(item.class)
  const label = translate('auto.components.right.sidebar.incidents.IncidentList.0827c60adc',
    '{{status}} {{class}} incident: {{summary}}',
    { status: statusLabel, class: classLabel, summary: item.summary }
  )
  return (
    <li role="none">
      <button
        ref={rowRef}
        type="button"
        tabIndex={tabIndex}
        aria-current={selected ? 'true' : undefined}
        aria-label={label}
        onClick={() => onOpen(item)}
        // Keep the roving index in step with Tab/mouse focus, so ArrowDown after a click moves from
        // the row the reader actually has, not from where the keyboard last was.
        onFocus={onFocus}
        className={cn(
          'grid w-full grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] leading-4 outline-none hover:bg-accent focus-visible:ring-[2px] focus-visible:ring-sidebar-ring/40',
          selected && 'bg-accent'
        )}
      >
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">
          {formatUiRelativeTime(item.createdAt - now)}
        </span>
        <span className="whitespace-nowrap font-medium">{classLabel}</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground" title={agent.title}>
          {agent.text}
        </span>
        <span className="truncate text-muted-foreground" title={item.worktreeId ?? undefined}>
          {item.worktreeId ?? '—'}
        </span>
        <span className="truncate" title={item.summary}>
          {item.summary}
        </span>
        <span
          className={cn(
            'whitespace-nowrap rounded border px-1 text-[10px]',
            STATUS_TONE[item.effectiveStatus]
          )}
          title={
            item.status === item.effectiveStatus
              ? undefined
              : translate('auto.components.right.sidebar.incidents.IncidentList.74f8811e39',
                  'Entry status: {{status}} (the row itself is immutable)',
                  { status: incidentStatusLabel(item.status) }
                )
          }
        >
          {statusLabel}
        </span>
      </button>
    </li>
  )
}

export function IncidentList({
  items,
  selectedId,
  now,
  empty,
  onOpen
}: {
  items: readonly IncidentListItemDto[]
  selectedId: string | null
  now: number
  empty: React.ReactNode
  onOpen: (item: IncidentListItemDto) => void
}): React.JSX.Element {
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  const focusRow = useCallback((index: number): void => {
    const clamped = Math.max(0, Math.min(rowRefs.current.length - 1, index))
    setFocusIndex(clamped)
    rowRefs.current[clamped]?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      const intent = resolveIncidentListNavigation({
        key: event.key,
        currentIndex: focusIndex,
        total: items.length,
        detailOpen: false
      })
      if (intent.type === 'focus') {
        event.preventDefault()
        focusRow(intent.index)
        return
      }
      if (intent.type === 'open' && focusIndex !== null) {
        const item = items[focusIndex]
        if (item) {
          event.preventDefault()
          onOpen(item)
        }
      }
    },
    [focusIndex, focusRow, items, onOpen]
  )

  if (items.length === 0) {
    return <div className="px-3 py-6 text-center text-xs text-muted-foreground">{empty}</div>
  }

  // The header row is visual: each row button already carries a full accessible label.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden="true"
        className="grid shrink-0 grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] gap-1.5 border-b border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        <span>{translate('auto.components.right.sidebar.incidents.IncidentList.26f51e9aac', 'time')}</span>
        <span>{translate('auto.components.right.sidebar.incidents.IncidentList.e192c09e58', 'class')}</span>
        <span>{translate('auto.components.right.sidebar.incidents.IncidentList.4408351160', 'agent')}</span>
        <span>
          {translate('auto.components.right.sidebar.incidents.IncidentList.3d4f036400', 'worktree')}
        </span>
        <span>
          {translate('auto.components.right.sidebar.incidents.IncidentList.3740b44fd7', 'key facts')}
        </span>
        <span>
          {translate('auto.components.right.sidebar.incidents.IncidentList.aa2c4cdf05', 'status')}
        </span>
      </div>
      <ul
        role="list"
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-1 py-1"
        onKeyDown={handleKeyDown}
      >
        {items.map((item, index) => (
          <IncidentRow
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            // Roving tabindex: one row is the tab stop, arrows move it.
            tabIndex={focusIndex === null ? (index === 0 ? 0 : -1) : focusIndex === index ? 0 : -1}
            now={now}
            onOpen={(next) => {
              setFocusIndex(index)
              onOpen(next)
            }}
            onFocus={() => setFocusIndex(index)}
            rowRef={(element) => {
              rowRefs.current[index] = element
            }}
          />
        ))}
      </ul>
    </div>
  )
}
