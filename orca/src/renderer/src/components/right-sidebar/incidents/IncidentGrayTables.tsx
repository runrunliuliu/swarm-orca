// The two grayscale read-only tables (§17 #18/#19 row, §12; M7-B).
//
// Both tables are wrapped in a dashed, muted surface with a standing sentence that says what the rows
// are: observations from a collector whose write switch is off by default. A row that *was* recorded
// (`written: true`, tool errors only) breaks out of that treatment with a solid border and a "recorded
// incident" chip, so the two states are distinguishable at a glance and without reading the copy.
//
// Neither table offers an action. These are diagnostics you read before deciding whether to turn a
// write switch on; the panel cannot turn it on, and offering a button here would imply it could.

import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  IncidentStallsViewDto,
  IncidentToolErrorsViewDto
} from '../../../../../shared/incident-gray-types'
import { stallRowKind, toolErrorTruncation, toolErrorWindowKind } from './incident-gray-model'

function Minutes({ ms }: { ms: number }): React.JSX.Element {
  return <span className="tabular-nums">{Math.round(ms / 60_000)}m</span>
}

function ObservedChrome({
  children,
  label
}: {
  children: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className="space-y-2 rounded border border-dashed border-border/70 bg-muted/30 px-2 py-2 text-muted-foreground"
    >
      <p className="flex items-start gap-1.5 rounded border border-dashed border-status-warning-border bg-status-warning-background px-1.5 py-1 text-[11px] text-foreground">
        <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-status-warning" />
        <span>
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.0884d2aab1',
            'These rows are observations only. With the write switch off (the default) no incident is recorded, so a row here is not an accident record.'
          )}
        </span>
      </p>
      {children}
    </section>
  )
}

function WriteSwitch({ enabled }: { enabled: boolean }): React.JSX.Element {
  return (
    <p className="text-[10px]">
      {enabled
        ? translate('auto.components.right.sidebar.incidents.IncidentGrayTables.e0e9fb16cf',
            'Writing incidents: on in this host process. Rows marked recorded have a stored incident.'
          )
        : translate('auto.components.right.sidebar.incidents.IncidentGrayTables.08a8f679fc',
            'Writing incidents: off in this host process. Nothing below has produced an incident row.'
          )}
    </p>
  )
}

export function IncidentStallsTable({ view }: { view: IncidentStallsViewDto }): React.JSX.Element {
  const writeEnabled = view.coverage.stallSample.writeEnabled
  return (
    <ObservedChrome
      label={translate('auto.components.right.sidebar.incidents.IncidentGrayTables.a67f20e39d',
        'Observed stalls (not recorded)'
      )}
    >
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.529c988940',
          'The sampler\'s last pass. "Would write" means a write-enabled sampler would record this now — never that the pane is confirmed stuck.'
        )}
      </p>
      <WriteSwitch enabled={writeEnabled} />
      {view.rows.length === 0 ? (
        <p className="text-[11px]">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.3cc4f4fee3',
            'No pane has been sampled yet. The sampler records one sample per minute while the runtime is up.'
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {view.rows.map((row) => {
            const kind = stallRowKind(row)
            return (
              <li
                key={row.paneKey}
                data-incident-gray-row={kind}
                className={cn(
                  'rounded border px-2 py-1 text-[10px]',
                  kind === 'recorded'
                    ? 'border-border bg-background text-foreground'
                    : 'border-dashed border-border/70 text-muted-foreground'
                )}
              >
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="truncate font-mono text-foreground">{row.paneKey}</span>
                  <span>{row.state}</span>
                  <span>
                    {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.983f1f4ffd',
                      'age'
                    )}{' '}
                    <Minutes ms={row.ageMs} />
                  </span>
                  <span
                    className={row.ageBasis === 'state_fallback' ? 'text-status-warning' : undefined}
                    title={
                      row.ageBasis === 'state_fallback'
                        ? translate('auto.components.right.sidebar.incidents.IncidentGrayTables.803a17a05a',
                            'No semantic event clock for this pane, so age falls back to stateStartedAt: a weaker signal.'
                          )
                        : undefined
                    }
                  >
                    {row.ageBasis}
                  </span>
                  <span>
                    {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.ae948293e3',
                      'threshold'
                    )}{' '}
                    <Minutes ms={row.thresholdMs} />
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2">
                  <span
                    className={cn(
                      'rounded border px-1',
                      row.wouldWriteIfEnabled
                        ? 'border-status-warning-border text-status-warning'
                        : 'border-border/60'
                    )}
                  >
                    {row.wouldWriteIfEnabled
                      ? translate('auto.components.right.sidebar.incidents.IncidentGrayTables.ce2c2f17d2',
                          'would write (not recorded)'
                        )
                      : translate('auto.components.right.sidebar.incidents.IncidentGrayTables.2988d6f3a2',
                          'would not write'
                        )}
                  </span>
                  <span className="truncate" title={row.reason}>
                    {row.reason}
                  </span>
                  {row.declaredWait !== null && (
                    <span className="truncate text-foreground" title={row.declaredWait}>
                      {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.9d0a503877',
                        'declared wait'
                      )}
                      : {row.declaredWait}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </ObservedChrome>
  )
}

export function IncidentToolErrorsTable({
  view
}: {
  view: IncidentToolErrorsViewDto
}): React.JSX.Element {
  const truncation = toolErrorTruncation(view)
  return (
    <ObservedChrome
      label={translate('auto.components.right.sidebar.incidents.IncidentGrayTables.05dd715ac5',
        'Observed tool errors (not recorded)'
      )}
    >
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.3ffb9723e7',
          'Per-turn windows from the structured session collector. The threshold and severity rules stay in the host process.'
        )}
      </p>
      <WriteSwitch enabled={view.writeEnabled} />
      {truncation.payloadTruncated && (
        <p className="text-[10px] text-status-warning">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.2c3641754f',
            'Showing {{published}} of {{total}} windows: the payload is capped, the rest are counted but not listed.',
            { published: view.published, total: view.total }
          )}
        </p>
      )}
      {truncation.evicted && (
        <p className="text-[10px] text-status-warning">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.00a3a930ba',
            '{{evicted}} window(s) were dropped by the in-process bound; those counts are lost.',
            { evicted: view.evicted }
          )}
        </p>
      )}
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.847e479adb',
          'Covered providers: {{list}}',
          { list: view.coveredProviders.join(', ') || '—' }
        )}
      </p>
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.4f8b2f1488',
          'Coverage gap: no tool-error data from {{list}}. Silence from them is not "no tool errors".',
          { list: view.uncoveredProviders.join(', ') || '—' }
        )}
      </p>
      {view.updatedAt === null ? (
        <p className="text-[11px]">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.8f749047f1',
            'No tool-error window has been observed on this host yet.'
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {view.windows.map((window) => {
            const kind = toolErrorWindowKind(window)
            return (
              <li
                key={`${window.sessionId}:${window.turn}:${window.toolName}:${window.code}:${window.windowStart}`}
                data-incident-gray-row={kind}
                className={cn(
                  'rounded border px-2 py-1 text-[10px]',
                  kind === 'recorded'
                    ? 'border-border bg-background text-foreground'
                    : 'border-dashed border-border/70 text-muted-foreground'
                )}
              >
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="truncate font-mono text-foreground">
                    {window.sessionId.slice(0, 8)}
                  </span>
                  <span>{window.toolName}</span>
                  <span className="font-mono">{window.code}</span>
                  <span className="tabular-nums">×{window.count}</span>
                  {window.highSeverity && (
                    <span className="rounded border border-status-warning-border px-1 text-status-warning">
                      {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.1f45a62bca',
                        'structured denial (single hit)'
                      )}
                    </span>
                  )}
                  {kind === 'recorded' ? (
                    <span className="rounded border border-border bg-secondary px-1 text-foreground">
                      {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.21da0872e8',
                        'recorded incident'
                      )}
                    </span>
                  ) : (
                    <span className="rounded border border-dashed border-border/70 px-1">
                      {window.wouldWriteIfEnabled
                        ? translate('auto.components.right.sidebar.incidents.IncidentGrayTables.ce2c2f17d2',
                            'would write (not recorded)'
                          )
                        : translate('auto.components.right.sidebar.incidents.IncidentGrayTables.3a1973e19f',
                            'observed only'
                          )}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </ObservedChrome>
  )
}
