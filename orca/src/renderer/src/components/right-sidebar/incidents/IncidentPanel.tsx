// The incidents panel (§12, M7-B): list + coverage + detail drawer + two grayscale tables.
//
// What this file is allowed to decide: which view is showing, which filters are applied, which row is
// open. What it is not: whether a row needs triage, whether a transition is legal, whether a stall is
// "confirmed", or whether the count is complete. Those arrive as data from the host (`effectiveStatus`,
// `appendDecision` outcomes, `coverage`) and are printed.
//
// The layout follows the design's split: the list is the panel, the detail is a right drawer, and the
// two grayscale tables are read-only peers of the list rather than a section inside it — they answer a
// different question ("what would the collectors write?") and must not be mistaken for more incidents.

import React, { useCallback, useMemo, useState } from 'react'
import { useNow } from '@/hooks/use-now'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { IncidentEvidencePointerDto } from '../../../../../shared/incident-api-types'
import { IncidentCoverageBanner } from './IncidentCoverageBanner'
import {
  incidentCoverageIsCurrentGap,
  incidentLocalCoverageGaps,
  incidentRemoteCoverageLine
} from './incident-coverage-banner'
import { IncidentDetailDrawer } from './IncidentDetailDrawer'
import { IncidentFilterBar } from './IncidentFilterBar'
import { IncidentPaneClocksTable, IncidentToolErrorsTable } from './IncidentGrayTables'
import { IncidentList } from './IncidentList'
import {
  DEFAULT_INCIDENT_FILTERS,
  applyIncidentViewFilters,
  incidentEmptyStateKind,
  incidentListRequest,
  incidentWorktreeOptions,
  type IncidentFilters
} from './incident-filter'
import {
  useIncidentDecide,
  useIncidentDetail,
  useIncidentSnapshot,
  useIncidentPaneClocks,
  useIncidentToolErrors
} from './use-incident-panel'

type IncidentPanelView = 'list' | 'paneClocks' | 'toolErrors'

const VIEW_LABEL: Record<IncidentPanelView, { key: string; fallback: string }> = {
  list: {
    key: 'auto.components.right.sidebar.incidents.IncidentPanel.viewList',
    fallback: 'List'
  },
  paneClocks: {
    key: 'auto.components.right.sidebar.incidents.IncidentPanel.viewStalls',
    fallback: 'Pane clocks'
  },
  toolErrors: {
    key: 'auto.components.right.sidebar.incidents.IncidentPanel.viewToolErrors',
    fallback: 'Tool errors'
  }
}

function emptyStateMessage(
  kind: ReturnType<typeof incidentEmptyStateKind>,
  counts: { shown: number; total: number }
): string {
  switch (kind) {
    case 'view_filtered':
      return translate('auto.components.right.sidebar.incidents.IncidentPanel.a49134b8d7',
        'None of the {{shown}} loaded row(s) match the worktree/time filter. The store reports {{total}} matching incident(s) for this status/class, and rows beyond the loaded page were not examined.',
        counts
      )
    case 'lower_bound':
      return translate('auto.components.right.sidebar.incidents.IncidentPanel.e1211cdfac',
        'Nothing matches in the rows loaded so far — and the coverage notes above say the list may be incomplete. This is not "nothing happened".'
      )
    case 'untriaged':
      return translate('auto.components.right.sidebar.incidents.IncidentPanel.98da243f4d',
        'No untriaged incidents. Confirmed, watched and archived rows are behind the Status filter.'
      )
    case 'filtered':
      return translate('auto.components.right.sidebar.incidents.IncidentPanel.9836d3085b',
        'No incident matches these filters.'
      )
  }
}

export default function IncidentPanel(): React.JSX.Element {
  const [filters, setFilters] = useState<IncidentFilters>(DEFAULT_INCIDENT_FILTERS)
  const [view, setView] = useState<IncidentPanelView>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // A shared 60s clock, not `Date.now()` in render: the lint rule is right that a render-time clock
  // makes the output unstable, and relative times that refresh on their own are also what a reader
  // watching a stale incident wants.
  const now = useNow(60_000)

  const request = useMemo(() => incidentListRequest(filters), [filters])
  const { snapshot, loading, error, reload } = useIncidentSnapshot(request)
  const detail = useIncidentDetail(selectedId)
  const paneClocks = useIncidentPaneClocks(view === 'paneClocks')
  const toolErrors = useIncidentToolErrors(view === 'toolErrors')

  const onAppended = useCallback(() => {
    reload()
    detail.reload()
  }, [detail, reload])
  const decide = useIncidentDecide({ onAppended })

  const items = useMemo(
    () => applyIncidentViewFilters(snapshot?.incidents ?? [], filters, now),
    [snapshot, filters, now]
  )
  const worktreeOptions = useMemo(
    () => incidentWorktreeOptions(snapshot?.incidents ?? []),
    [snapshot]
  )
  // Local gaps are primary; the remote line is secondary and is only rendered when it is a monitored
  // hole (the `not_configured` case belongs to the drawer). See incident-remote-coverage.ts.
  const localGaps = useMemo(
    () =>
      snapshot === null
        ? []
        : incidentLocalCoverageGaps({
            coverage: snapshot.coverage,
            // The truncation gap is about the page the panel holds, not the store total.
            shown: snapshot.incidents.length,
            total: snapshot.total
          }),
    [snapshot]
  )
  const remoteLine = useMemo(
    () => (snapshot === null ? null : incidentRemoteCoverageLine(snapshot.coverage)),
    [snapshot]
  )
  // Why surfaced separately: these two filters run over the loaded page, not the store. An empty
  // result from them is not a statement about the store, and the panel must say which it is.
  const viewFilterActive = filters.worktree !== 'all' || filters.window !== 'all'
  const listIsLowerBound = snapshot !== null && incidentCoverageIsCurrentGap(localGaps)
  const emptyStateKind = incidentEmptyStateKind({ filters, localGap: listIsLowerBound })

  const openEvidence = useCallback((pointer: IncidentEvidencePointerDto) => {
    // The existing file-open capability, deliberately not an editor jump: a pointer carries a byte
    // offset, not a line, and this panel must not read the file to invent one (§6.3).
    void window.api?.shell?.openPath(pointer.path)
  }, [])

  function renderBody(): React.JSX.Element {
    if (view === 'paneClocks') {
      return (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-2 py-2">
          {paneClocks.error !== null ? (
            <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px]">
              {paneClocks.error}
            </p>
          ) : paneClocks.view === null ? (
            <p className="text-[11px] text-muted-foreground">
              {paneClocks.loading
                ? translate('auto.components.right.sidebar.incidents.IncidentPanel.da40792d38',
                    'Reading the stall sampler\'s last pass…'
                  )
                : translate('auto.components.right.sidebar.incidents.IncidentPanel.63569b95d6',
                    'No stall sample is available from this host.'
                  )}
            </p>
          ) : (
            <IncidentPaneClocksTable view={paneClocks.view} />
          )}
        </div>
      )
    }
    if (view === 'toolErrors') {
      return (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-2 py-2">
          {toolErrors.error !== null ? (
            <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px]">
              {toolErrors.error}
            </p>
          ) : toolErrors.view === null ? (
            <p className="text-[11px] text-muted-foreground">
              {toolErrors.loading
                ? translate('auto.components.right.sidebar.incidents.IncidentPanel.e82403c02d',
                    'Reading the tool-error windows…'
                  )
                : translate('auto.components.right.sidebar.incidents.IncidentPanel.b683788f7d',
                    'No tool-error window snapshot is available from this host.'
                  )}
            </p>
          ) : (
            <IncidentToolErrorsTable view={toolErrors.view} />
          )}
        </div>
      )
    }

    if (error !== null) {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <AlertTriangle size={24} className="opacity-50" />
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.right.sidebar.incidents.IncidentPanel.7cfb402490',
              'The incident store could not be read, so this is not a claim that there are no incidents.'
            )}
          </p>
          <p className="text-[10px] text-muted-foreground">{error}</p>
        </div>
      )
    }
    if (snapshot === null) {
      return (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          {translate('auto.components.right.sidebar.incidents.IncidentPanel.0a4c414c89',
            'Reading incidents from this host…'
          )}
        </p>
      )
    }
    return (
      <IncidentList
        items={items}
        selectedId={selectedId}
        now={now}
        onOpen={(item) => setSelectedId(item.id)}
        empty={emptyStateMessage(emptyStateKind, {
          shown: snapshot.incidents.length,
          total: snapshot.total
        })}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          {(Object.keys(VIEW_LABEL) as IncidentPanelView[]).map((candidate) => {
            const label = VIEW_LABEL[candidate]
            return (
              <Button
                key={candidate}
                type="button"
                size="xs"
                variant={view === candidate ? 'secondary' : 'ghost'}
                aria-pressed={view === candidate}
                onClick={() => setView(candidate)}
              >
                {translate(label.key, label.fallback)}
              </Button>
            )
          })}
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={translate('auto.components.right.sidebar.incidents.IncidentPanel.b9125ea2ff',
            'Reload incidents'
          )}
          onClick={() => {
            reload()
            if (view === 'paneClocks') {
              paneClocks.reload()
            }
            if (view === 'toolErrors') {
              toolErrors.reload()
            }
          }}
        >
          <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      {view === 'list' && snapshot !== null && (
        <IncidentCoverageBanner localGaps={localGaps} remoteLine={remoteLine} />
      )}
      {view === 'list' && (
        <IncidentFilterBar
          filters={filters}
          worktreeOptions={worktreeOptions}
          onChange={setFilters}
          onClear={() => setFilters(DEFAULT_INCIDENT_FILTERS)}
        />
      )}
      {view === 'list' && snapshot !== null && viewFilterActive && (
        <p className="shrink-0 border-b border-border px-3 py-1 text-[10px] text-muted-foreground">
          {translate('auto.components.right.sidebar.incidents.IncidentPanel.de8cfc79a1',
            'Worktree and time filters apply to the {{shown}} loaded row(s) only; the store query is not filtered by them ({{total}} match this status/class).',
            { shown: snapshot.incidents.length, total: snapshot.total }
          )}
        </p>
      )}

      {renderBody()}

      <IncidentDetailDrawer
        detail={detail.detail}
        loading={detail.loading}
        error={detail.error}
        now={now}
        coverageLocalGaps={localGaps}
        coverageRemoteLine={remoteLine}
        onClose={() => setSelectedId(null)}
        onDecide={decide}
        onOpenEvidence={openEvidence}
      />
    </div>
  )
}
